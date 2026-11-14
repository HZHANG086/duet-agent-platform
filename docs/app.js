"use strict";

const byId = (id) => document.getElementById(id);
const sampleButtons = [...document.querySelectorAll("[data-sample]")];
const renderedReport = byId("report");
const notice = byId("notice");
const preview = byId("preview");
const upload = byId("upload");
const submit = byId("submit");
const fileInput = byId("file");
const localReport = byId("local-report");
const imageDrop = byId("image-drop");
const jpegButton = byId("local-jpeg");
const jpegStatus = byId("jpeg-preview-status");
const downloadButton = byId("download");
const replayNext = byId("replay-next");
const replayToggle = byId("replay-toggle");
const workflowSteps = byId("workflow-steps");
const chatLog = byId("assistant-log");
const chatInput = byId("assistant-input");
const chatButtons = [...document.querySelectorAll("[data-question]")];
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const PREVIEW_MAX_EDGE = 2048;

const reasonText = {
  near_decision_threshold: "The score is near the decision threshold.",
  expert_disagreement: "The experts strongly disagree.",
  verdict_changed_after_recompression: "The verdict changed after recompression.",
  recheck_failed: "The JPEG recheck failed. The initial result is retained for human review.",
};
const toolLabels = {
  decode_image: "Decode image",
  duet_primary: "Run initial DUET detection",
  evaluate_review_policy: "Decide whether to recheck",
  duet_jpeg_recheck: "Recompress and run DUET again",
  finalize_review: "Set review outcome",
};

const catalog = typeof duetSamples !== "undefined" ? duetSamples : null;
let activeReport;
let objectUrl;
let busy = false;
let live = false;
let replayStep = null;
let imageRevision = 0;
let localImage;
let chatTopic;
const localFile = window.location.protocol === "file:";
const backend = new URL(publicBackend || "./", window.location.href);
const endpoint = (path) => new URL(path, backend);

function setPreview(source, alt) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = typeof source === "string" ? undefined : URL.createObjectURL(source);
  preview.src = objectUrl ?? source;
  preview.alt = alt;
}

function setNotice(message, error = false) {
  notice.textContent = message;
  notice.hidden = !message;
  notice.toggleAttribute("data-error", error);
}

function renderReplay() {
  const trace = activeReport.trace ?? [];
  const replaying = replayStep !== null;
  const current = replayStep ?? trace.length - 1;
  const visible = trace.slice(0, current + 1);
  const final = !replaying || current === trace.length - 1;
  const scored = !replaying || visible.some((step) => step.tool === "duet_primary");
  byId("route-facts").hidden = !scored;
  byId("scoring").hidden = !scored;
  byId("review-panel").hidden = !final;
  workflowSteps.hidden = !replaying;
  replayNext.hidden = !replaying || final;
  replayToggle.textContent = replaying ? "Full report" : "Replay workflow";
  downloadButton.disabled = !final;
  byId("trace-position").textContent = replaying ? `Step ${current + 1} of ${trace.length}` : "";
  workflowSteps.replaceChildren(...visible.map((entry, index) => {
    const item = document.createElement("li");
    if (index === current) item.setAttribute("aria-current", "step");
    item.toggleAttribute("data-failed", entry.status === "failed");
    const details = document.createElement("details");
    details.open = index === current;
    const summary = document.createElement("summary");
    summary.textContent = `${toolLabels[entry.tool] ?? entry.tool} · ${entry.status} · ${entry.elapsed_ms} ms`;
    const payload = document.createElement("pre");
    payload.textContent = JSON.stringify({input: entry.input, output: entry.output}, null, 2);
    details.append(summary, payload);
    item.append(details);
    return item;
  }));
}

function renderReport(report, preserveChat = false) {
  activeReport = report;
  replayStep = null;
  localReport.hidden = true;
  const hasTrace = Array.isArray(report.trace) && report.trace.length > 0;
  byId("replay").hidden = !hasTrace;
  const runDetails = byId("run-details");
  runDetails.hidden = !hasTrace;
  if (hasTrace) runDetails.textContent = `${report.model} · Run ${report.run_id.slice(0, 8)}`;
  const primary = report.primary;
  const verdict = primary.label === "synthetic" ? "AI-generated" : "Real";
  byId("dimensions").textContent = `${report.width} × ${report.height} px`;
  byId("score").textContent = primary.score.toFixed(3);
  byId("score-marker").style.left = `${primary.score * 100}%`;
  byId("label").textContent = verdict;
  byId("route").textContent = primary.route === "shallow" ? "Early exit" : "Deep";
  byId("depth").textContent = `${primary.depth} blocks`;
  byId("duration").textContent = primary.inference_ms >= 1000
    ? `${(primary.inference_ms / 1000).toFixed(2)} s` : `${primary.inference_ms} ms`;
  byId("votes").replaceChildren(...primary.layers.map((layer, index) => {
    const row = document.createElement("div");
    row.className = "vote";
    const label = document.createElement("span");
    label.textContent = `L${layer}`;
    const meter = document.createElement("meter");
    meter.min = 0;
    meter.max = 1;
    meter.value = primary.votes[index];
    meter.setAttribute("aria-label", `Layer ${layer} vote`);
    const value = document.createElement("span");
    value.textContent = meter.value.toFixed(3);
    row.append(label, meter, value);
    return row;
  }));
  const requiresReview = report.status === "review";
  byId("review-title").parentElement.toggleAttribute("data-review", requiresReview);
  byId("review-title").textContent = requiresReview ? "Human review suggested" : "Inspection completed";
  byId("reasons").textContent = requiresReview
    ? report.reasons.map((reason) => reasonText[reason]).join(" ")
    : report.recompression_check
      ? "The requested JPEG pass did not change the verdict. No review flags were raised."
      : "The initial score and expert votes met the single-pass criteria.";
  const check = report.recompression_check;
  byId("compare").hidden = !check;
  if (check) {
    const secondVerdict = check.label === "synthetic" ? "AI-generated" : "Real";
    byId("compare").textContent = `JPEG check  ${check.score.toFixed(3)} · ${secondVerdict} · L${check.depth}`;
  }
  renderReplay();
  renderedReport.hidden = false;
  setNotice("");
  refreshChat(!preserveChat);
}

function chatTurn(message, user = false, steps = [], action = null) {
  const entry = document.createElement("div");
  entry.className = "assistant-turn";
  entry.toggleAttribute("data-user", user);
  const p = document.createElement("p");
  p.textContent = message;
  entry.append(p);
  const report = activeReport;
  for (const [type, label] of steps) {
    const index = report?.trace?.findIndex((step) => step.tool === type) ?? -1;
    if (index < 0) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label + " ↗";
    button.dataset.evidence = "";
    button.addEventListener("click", () => {
      if (report !== activeReport || busy) return;
      replayStep = index;
      renderReplay();
      const target = workflowSteps.children[index];
      target.querySelector("summary").focus({preventScroll: true});
      target.scrollIntoView({block: "center"});
    });
    entry.append(button);
  }
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    button.dataset.evidence = "";
    entry.append(button);
  }
  chatLog.append(entry);
  while (chatLog.children.length > 30) chatLog.firstElementChild.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

function refreshChat(reset = false) {
  const recorded = !!activeReport && !localImage;
  const context = activeReport ? `${recorded ? "Recorded" : "Live"} · ${activeReport.run_id.slice(0, 8)}` : "No inspection yet";
  byId("assistant-context").textContent = context;
  byId("assistant-recheck").hidden = !live || !localImage || !activeReport;
  byId("assistant-run").hidden = !live || !localImage || !!activeReport;
  byId("assistant-send").disabled = busy;
  chatInput.disabled = busy;
  chatButtons.forEach((button) => { button.disabled = busy || (!activeReport && !button.id); });
  if (!reset) return;
  chatTopic = undefined;
  chatInput.value = "";
  chatLog.replaceChildren();
  chatTurn(activeReport
    ? `I can explain the inspection for ${byId("sample-name").textContent}, including why DUET suggested a review or what happened after JPEG compression.`
    : live && localImage ? "This image is ready. Ask me to run DUET to create an inspection record."
      : "This is a browser preview. Select a built-in sample to discuss its model results.");
}

async function askAssistant(question) {
  question = question.trim();
  if (!question || busy) return;
  const zh = reviewAssistant.useChinese(question);
  const say = (en, cn) => zh ? cn : en;
  const topic = reviewAssistant.intent(question, chatTopic);
  chatTurn(question, true);
  if (topic === "run" || topic === "recheck") {
    if (!live || !localImage) {
      chatTurn(say(
        "I can explain the recorded runs here. To run DUET on an uploaded image, open the local workbench and select an image.",
        "这里可以解读已有记录。要对新图执行检测，请打开本地工作台并上传图片。"));
      return;
    }
    const explicit = topic === "recheck";
    chatTurn(explicit ? say("Running a fresh inspection with a JPEG check.", "正在重新初检，并执行一次 JPEG 复测。")
      : say("Running DUET on the selected image.", "正在检测这张图。"));
    const result = await runInspection({forceRecheck: explicit, preserveChat: true});
    if (result.error) {
      chatTurn(say(`No new report: ${result.error}`, `未生成新报告：${result.error}`));
      return;
    }
    chatTopic = explicit ? "compare" : "score";
    const answer = reviewAssistant.answer(result.report, chatTopic, zh);
    chatTurn(say("New run: ", "新记录：") + result.report.run_id.slice(0, 8) + "\n" + answer.message,
      false, evidenceLinks(answer.steps, zh));
    return;
  }
  if (!activeReport) {
    chatTurn(live && localImage ? say("Run DUET first to create a report.", "请先运行 DUET 生成检测记录。")
      : say("Select a built-in sample to ask about its recorded inspection.", "请先选一个内置样例，再追问它的检测结果。"));
    return;
  }
  if (topic === "export") {
    const report = activeReport;
    chatTurn(say("The JSON includes the scores, review reasons, and execution trace.",
      "JSON 包含分数、复核原因和完整执行记录。"), false, [], {
      label: say("Download JSON", "下载 JSON"),
      run: () => { if (activeReport === report && !busy) downloadReport(report); },
    });
    return;
  }
  if (topic) chatTopic = topic;
  const answer = reviewAssistant.answer(activeReport, topic, zh);
  chatTurn(answer.message, false, evidenceLinks(answer.steps, zh));
}

function evidenceLinks(steps, zh) {
  return steps.map((step) => [step, (zh ? reviewAssistant.stepZh : reviewAssistant.stepLabel)[step]]);
}

byId("assistant-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const question = chatInput.value;
  chatInput.value = "";
  void askAssistant(question);
});
chatButtons.forEach((button) => button.addEventListener("click", () => {
  void askAssistant(button.dataset.question);
}));

function selectSample(index) {
  const sample = catalog.samples[index];
  imageRevision += 1;
  localImage = undefined;
  fileInput.value = "";
  submit.disabled = true;
  showInputError("");
  setPreview(sample.url, sample.title);
  byId("sample-name").textContent = sample.title;
  byId("mode").textContent = "Recorded model run";
  sampleButtons.forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.sample) === index)));
  renderReport(sample.report);
}

replayToggle.addEventListener("click", () => {
  replayStep = replayStep === null ? 0 : null;
  renderReplay();
});
replayNext.addEventListener("click", () => {
  replayStep += 1;
  renderReplay();
  if (replayNext.hidden) replayToggle.focus();
});

sampleButtons.forEach((button) => {
  button.disabled = !catalog;
  button.addEventListener("click", () => selectSample(Number(button.dataset.sample)));
});

function downloadReport(report) {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: "application/json"}));
  const download = document.createElement("a");
  download.href = url;
  download.download = "duet-inspection.json";
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
downloadButton.addEventListener("click", () => downloadReport(activeReport));

function showInputError(message) {
  const error = byId("input-error");
  error.textContent = message;
  error.hidden = !message;
}

function displayBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 ** 2).toFixed(2)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;
}

function showLocalVariant(jpeg) {
  if (!localImage || (jpeg && !localImage.jpeg)) return;
  setPreview(jpeg ? localImage.jpeg : localImage.file, jpeg ? "JPEG preview" : "Your original image");
  byId("local-original").setAttribute("aria-pressed", String(!jpeg));
  byId("local-jpeg").setAttribute("aria-pressed", String(jpeg));
}

byId("local-original").addEventListener("click", () => showLocalVariant(false));
jpegButton.addEventListener("click", async () => {
  const selected = localImage;
  if (!selected) return;
  if (!selected.jpeg) {
    jpegButton.disabled = true;
    jpegStatus.textContent = "Preparing JPEG preview…";
    try {
      const image = preview;
      await image.decode();
      if (localImage !== selected) return;
      const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      selected.jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.65));
      if (!selected.jpeg) throw new Error("The JPEG preview could not be created.");
      if (localImage !== selected) return;
      byId("jpeg-bytes").textContent = displayBytes(selected.jpeg.size);
      jpegStatus.textContent = scale < 1 ? `JPEG preview resized to ${canvas.width} × ${canvas.height} px.` : "";
    } catch (error) {
      if (localImage === selected) jpegStatus.textContent = error.message;
      return;
    } finally {
      if (localImage === selected) jpegButton.disabled = false;
    }
  }
  if (localImage === selected) showLocalVariant(true);
});

async function prepareLocalImage(file) {
  if (!file || busy) return;
  const revision = ++imageRevision;
  localImage = undefined;
  showInputError("");
  submit.disabled = true;
  jpegButton.disabled = true;
  jpegStatus.textContent = "";
  setNotice("Opening image…");
  const url = URL.createObjectURL(file);
  try {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      throw new Error("Choose a JPEG, PNG or WebP image.");
    }
    if (file.size > MAX_BYTES) throw new Error("The image exceeds 8 MiB.");
    const decoded = new Image();
    decoded.src = url;
    await decoded.decode().catch(() => {
      throw new Error("The image could not be decoded.");
    });
    if (revision !== imageRevision) return;
    const width = decoded.naturalWidth;
    const height = decoded.naturalHeight;
    if (width * height > MAX_PIXELS) throw new Error("The image exceeds 20 megapixels.");
    localImage = {file};
    byId("mode").textContent = "Browser preview";
    byId("sample-name").textContent = file.name;
    byId("dimensions").textContent = `${width} × ${height} px`;
    byId("local-format").textContent = file.type.split("/")[1].toUpperCase();
    byId("local-bytes").textContent = displayBytes(file.size);
    byId("jpeg-bytes").textContent = "Not generated";
    sampleButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
    activeReport = undefined;
    downloadButton.disabled = true;
    renderedReport.hidden = true;
    localReport.hidden = false;
    setNotice("");
    showLocalVariant(false);
    jpegButton.disabled = false;
    submit.disabled = false;
    refreshChat(true);
  } catch (error) {
    if (revision !== imageRevision) return;
    fileInput.value = "";
    localImage = undefined;
    showInputError(error.message);
    if (renderedReport.hidden && localReport.hidden) {
      setNotice("Choose a built-in sample or add a supported image.");
    } else setNotice("");
  } finally {
    URL.revokeObjectURL(url);
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  prepareLocalImage(file);
});

for (const eventName of ["dragover", "drop"]) {
  document.addEventListener(eventName, (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
}
imageDrop.addEventListener("dragover", (event) => {
  if (event.dataTransfer.types.includes("Files")) imageDrop.setAttribute("data-dragging", "");
});
imageDrop.addEventListener("dragleave", (event) => {
  if (!imageDrop.contains(event.relatedTarget)) imageDrop.removeAttribute("data-dragging");
});
imageDrop.addEventListener("drop", (event) => {
  imageDrop.removeAttribute("data-dragging");
  prepareLocalImage(event.dataTransfer.files[0]);
});
document.addEventListener("paste", (event) => {
  const file = [...event.clipboardData.files].find((item) => item.type.startsWith("image/"));
  if (file) {
    event.preventDefault();
    prepareLocalImage(file);
  }
});

async function runInspection({forceRecheck = false, preserveChat = false} = {}) {
  const file = localImage?.file;
  if (!live || !file || busy) return {error: "No image is ready for inspection."};
  busy = true;
  refreshChat();
  submit.disabled = true;
  const bodyData = new FormData();
  bodyData.append("image", file, file.name);
  if (forceRecheck) bodyData.append("force_recheck", "true");
  fileInput.disabled = true;
  downloadButton.disabled = true;
  sampleButtons.forEach((button) => { button.disabled = true; });
  setNotice("Running DUET inspection…");
  try {
    const response = await fetch(endpoint("api/inspect"), {
      method: "POST",
      body: bodyData,
      signal: AbortSignal.timeout(140000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const fallback = response.status === 429
        ? "The detector is busy. Try again shortly."
        : "The detector is temporarily unavailable. Try again shortly.";
      throw new Error(typeof body?.detail === "string" ? body.detail : fallback);
    }
    if (!body?.primary) throw new Error("The detector returned an invalid report.");
    setPreview(file, "Uploaded image");
    byId("sample-name").textContent = file.name;
    byId("mode").textContent = "Live inference";
    sampleButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
    if (preserveChat) {
      for (const button of chatLog.querySelectorAll("[data-evidence]")) {
        button.disabled = true;
        button.title = "This link belongs to the previous run.";
      }
    }
    renderReport(body, preserveChat);
    return {report: body};
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "The detector took too long to respond. Try again shortly."
      : error.message;
    setNotice(message || "Could not reach the DUET service.", true);
    if (activeReport) renderReplay();
    return {error: message || "Could not reach the DUET service."};
  } finally {
    fileInput.disabled = false;
    submit.disabled = false;
    sampleButtons.forEach((button) => { button.disabled = !catalog; });
    busy = false;
    refreshChat();
  }
}
upload.addEventListener("submit", (event) => {
  event.preventDefault();
  void runInspection();
});

async function detectServer() {
  if (localFile) return;
  if (!publicBackend) {
    const response = await fetch(endpoint("api/health"), {signal: AbortSignal.timeout(3000)});
    if (!response.ok || (await response.json()).status !== "ready") return;
  }
  live = true;
  submit.hidden = false;
  submit.disabled = !localImage;
  byId("upload-note").textContent = "JPEG, PNG or WebP up to 8 MiB. The image is sent to DUET only when you select Run DUET.";
  byId("local-report").querySelector(".hint").textContent =
    "Switch between the original and a browser-generated JPEG preview, or select Run DUET to run the model on the original.";
  refreshChat(!activeReport);
}

if (catalog) selectSample(0);
else {
  setNotice("Sample reports could not be loaded.", true);
  refreshChat(true);
}
detectServer().catch(() => {});

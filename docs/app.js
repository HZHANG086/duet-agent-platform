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
const downloadButton = byId("download");
const replayNext = byId("replay-next");
const replayToggle = byId("replay-toggle");
const workflowSteps = byId("workflow-steps");
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;

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

function renderReport(report) {
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
}

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

downloadButton.addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(activeReport, null, 2)], {type: "application/json"}));
  const download = document.createElement("a");
  download.href = url;
  download.download = "duet-inspection.json";
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

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
  if (!localImage) return;
  setPreview(jpeg ? localImage.jpeg : localImage.file, jpeg ? "JPEG preview" : "Your original image");
  byId("local-original").setAttribute("aria-pressed", String(!jpeg));
  byId("local-jpeg").setAttribute("aria-pressed", String(jpeg));
}

byId("local-original").addEventListener("click", () => showLocalVariant(false));
byId("local-jpeg").addEventListener("click", () => showLocalVariant(true));

fileInput.addEventListener("change", async () => {
  const revision = ++imageRevision;
  const file = fileInput.files[0];
  if (!file || busy) return;
  showInputError("");
  submit.disabled = true;
  try {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      throw new Error("Choose a JPEG, PNG or WebP image.");
    }
    if (file.size > MAX_BYTES) throw new Error("The image exceeds 8 MiB.");
    const bitmap = await createImageBitmap(file).catch(() => {
      throw new Error("The image could not be decoded.");
    });
    const {width, height} = bitmap;
    const canvas = document.createElement("canvas");
    try {
      if (width * height > MAX_PIXELS) throw new Error("The image exceeds 20 megapixels.");
      if (revision !== imageRevision) return;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0);
    } finally {
      bitmap.close();
    }
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.65));
    if (revision !== imageRevision) return;
    if (!jpeg) throw new Error("The JPEG preview could not be created.");
    localImage = {file, jpeg};
    byId("mode").textContent = "Browser preview";
    byId("sample-name").textContent = file.name;
    byId("dimensions").textContent = `${width} × ${height} px`;
    byId("local-format").textContent = file.type.split("/")[1].toUpperCase();
    byId("local-bytes").textContent = displayBytes(file.size);
    byId("jpeg-bytes").textContent = displayBytes(jpeg.size);
    sampleButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
    activeReport = undefined;
    downloadButton.disabled = true;
    renderedReport.hidden = true;
    localReport.hidden = false;
    setNotice("");
    showLocalVariant(false);
    submit.disabled = false;
  } catch (error) {
    if (revision !== imageRevision) return;
    fileInput.value = "";
    localImage = undefined;
    showInputError(error.message);
    if (renderedReport.hidden && localReport.hidden) {
      setNotice("Choose a built-in sample or add a supported image.");
    }
  }
});

upload.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = localImage?.file;
  if (!live || !file || busy) return;
  busy = true;
  submit.disabled = true;
  const bodyData = new FormData();
  bodyData.append("image", file, file.name);
  fileInput.disabled = true;
  downloadButton.disabled = true;
  sampleButtons.forEach((button) => { button.disabled = true; });
  renderedReport.hidden = true;
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
    renderReport(body);
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "The detector took too long to respond. Try again shortly."
      : error.message;
    setNotice(message || "Could not reach the DUET service.", true);
  } finally {
    fileInput.disabled = false;
    submit.disabled = false;
    sampleButtons.forEach((button) => { button.disabled = !catalog; });
    busy = false;
  }
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
}

if (catalog) selectSample(0);
else setNotice("Sample reports could not be loaded.", true);
detectServer().catch(() => {});

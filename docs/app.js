import { publicBackend } from "./backend-config.js";

const byId = (id) => document.getElementById(id);
const sampleButtons = [...document.querySelectorAll("[data-sample]")];
const renderedReport = byId("report");
const notice = byId("notice");
const preview = byId("preview");
const upload = byId("upload");
const submit = byId("submit");

const reasonText = {
  near_decision_threshold: "The score is near the decision threshold.",
  expert_disagreement: "The experts strongly disagree.",
  verdict_changed_after_recompression: "The verdict changed after recompression.",
};

let catalog;
let activeReport;
let objectUrl;
let busy = false;
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

function renderReport(report) {
  activeReport = report;
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
  byId("download").disabled = false;
  renderedReport.hidden = false;
  setNotice("");
}

function selectSample(index) {
  const sample = catalog.samples[index];
  setPreview(sample.url, `${sample.title} of NASA astronaut Eileen Collins`);
  byId("sample-name").textContent = sample.title;
  byId("mode").textContent = "Recorded model run";
  sampleButtons.forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.sample) === index)));
  renderReport(sample.report);
}

sampleButtons.forEach((button) => {
  button.disabled = true;
  button.addEventListener("click", () => selectSample(Number(button.dataset.sample)));
});

byId("download").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(activeReport, null, 2)], {type: "application/json"}));
  const download = document.createElement("a");
  download.href = url;
  download.download = "duet-inspection.json";
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

upload.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = byId("file").files[0];
  if (!file || busy) return;
  if (file.size > 8 * 1024 * 1024) {
    setNotice("The image exceeds 8 MiB.", true);
    return;
  }
  busy = true;
  submit.disabled = true;
  byId("download").disabled = true;
  sampleButtons.forEach((button) => { button.disabled = true; });
  renderedReport.hidden = true;
  setNotice("Running DUET inspection…");
  try {
    const response = await fetch(endpoint("api/inspect"), {
      method: "POST",
      body: new FormData(upload),
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
    submit.disabled = false;
    sampleButtons.forEach((button) => { button.disabled = !catalog; });
    busy = false;
  }
});

async function loadSamples() {
  const response = await fetch("samples.json");
  if (!response.ok) throw new Error("Sample reports are unavailable.");
  catalog = await response.json();
  sampleButtons.forEach((button) => { button.disabled = false; });
  selectSample(0);
}

async function detectServer() {
  if (!publicBackend) {
    const response = await fetch(endpoint("api/health"), {signal: AbortSignal.timeout(3000)});
    if (!response.ok || (await response.json()).status !== "ready") return;
  }
  upload.hidden = false;
  byId("host-note").hidden = true;
}

try {
  await loadSamples();
} catch {
  setNotice("Sample reports could not be loaded.", true);
}
detectServer().catch(() => {});

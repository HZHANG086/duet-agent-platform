"use strict";

const reviewAssistant = (() => {
  const stepLabel = {
    duet_primary: "Initial detection",
    evaluate_review_policy: "Review policy",
    duet_jpeg_recheck: "JPEG recheck",
    finalize_review: "Final outcome",
  };
  const stepZh = {
    duet_primary: "初检",
    evaluate_review_policy: "复核规则",
    duet_jpeg_recheck: "JPEG 复测",
    finalize_review: "最终结论",
  };
  const number = (value) => value.toFixed(3);
  const useChinese = (question) => /[\u3400-\u9fff]/u.test(question);
  function intent(question, previous) {
    const q = question.toLowerCase();
    if (/^(?:run (?:a )?(?:fresh )?(?:jpeg )?recheck|recheck (?:this image|it)|rerun (?:the )?jpeg (?:recheck|check))[.!\s]*$/i.test(q)
      || /^(?:请)?(?:帮我)?(?:再|重新)?(?:跑一次|执行|发起|做一次|做个)?(?:jpeg\s*)?(?:复测|重测|再检测一次)(?:一次|一下|这张图)?[。！\s]*$/iu.test(q)) return "recheck";
    if (/^(?:run duet(?: on (?:this image|it))?|inspect (?:this image|it)|(?:请|帮我)?(?:运行\s*duet|检测(?:这张图|这张图片|一下|此图)))[。！.!\s]*$/iu.test(q)) return "run";
    if (/download|export|导出|下载/i.test(q)) return "export";
    if (/why.*(?:review|flag|recheck)|为什么.*(?:复核|复测)|为何.*(?:复核|复测)/i.test(q)) return "review";
    if (/vote|disagree|分歧|投票|专家/i.test(q)) return "votes";
    if (/jpeg|compress|recheck|复测|压缩|变了|变化|翻转/i.test(q)) return "compare";
    if (/layer|route|depth|exit|哪几?层|路径|深度|早退|第几层/i.test(q)) return "route";
    if (/threshold|cutoff|阈值|门槛/i.test(q)) return "threshold";
    if (/review|flag|人工|复核/i.test(q)) return "review";
    if (/^(?:and |what about )?(?:the )?(?:delta|difference|how much)[?\s]*$|差多少|差了多少/i.test(q) && previous) return previous;
    if (/score|verdict|generated|synthetic|real|分数|判定|结果|真假|生成的/i.test(q)) return "score";
    return null;
  }

  function answer(report, topic, zh) {
    const say = (en, cn) => zh ? cn : en;
    const result = (message, ...steps) => ({message, steps});
    const {primary, recompression_check: check, trace, status, reasons} = report;
    const policy = trace?.find((step) => step.tool === "evaluate_review_policy")?.input;
    const verdict = (label) => label === "synthetic" ? say("AI-generated", "AI 生成") : say("real", "真实图像");
    const score = (detection) => `${number(detection.score)} · ${verdict(detection.label)}`;
    if (topic === "compare") {
      if (!check) {
        if (reasons.includes("recheck_failed")) {
          return result(say(`JPEG recheck failed. Only the initial result is available: ${score(primary)}.`,
            `JPEG 复测失败，目前只保留初检结果：${score(primary)}。`), "duet_jpeg_recheck");
        }
        return result(say(`The initial result was ${score(primary)}. This run did not perform a JPEG recheck, so there are no two scores to compare.`,
          `初检结果为 ${score(primary)}。这条记录没有执行 JPEG 复测，无法比较前后分数。`), "evaluate_review_policy");
      }
      const delta = check.score - primary.score;
      const signed = (delta >= 0 ? "+" : "") + number(delta);
      const changed = check.label !== primary.label;
      return result(say(`Original: ${score(primary)}. JPEG: ${score(check)}. Score change: ${signed}. The verdict ${changed ? "changed" : "stayed the same"}.`,
        `原图：${score(primary)}；JPEG：${score(check)}。分数变化 ${signed}，判定${changed ? "改变了" : "没有改变"}。`),
      "duet_primary", "duet_jpeg_recheck");
    }
    if (topic === "route") {
      const layers = primary.layers.join(", ");
      return result(say(`DUET used the ${primary.route === "shallow" ? "early-exit" : "deep"} route at block ${primary.depth}. Expert layers: ${layers}.`,
        `DUET 走的是${primary.route === "shallow" ? "早退出" : "深层"}路径，在第 ${primary.depth} 层结束。参与打分的专家层：${layers}。`), "duet_primary");
    }
    if (topic === "votes") {
      const votes = primary.layers.map((layer, i) => `L${layer} ${number(primary.votes[i])}`);
      const low = Math.min(...primary.votes);
      const high = Math.max(...primary.votes);
      const lowLayer = primary.layers[primary.votes.indexOf(low)];
      const highLayer = primary.layers[primary.votes.indexOf(high)];
      return result(say(`Expert votes: ${votes.join(", ")}. ${low === high ? "The votes are tied." : `L${lowLayer} and L${highLayer} differ the most, by ${number(high - low)}.`}`,
        `各层打分：${votes.join("、")}。${low === high ? "各层打分相同。" : `L${lowLayer} 和 L${highLayer} 差得最多，相差 ${number(high - low)}。`}`),
      "duet_primary", "evaluate_review_policy");
    }
    if (topic === "threshold") {
      const margin = number(policy?.score_margin ?? Math.abs(primary.score - 0.5));
      return result(say(`The decision boundary is 0.500. The initial score was ${number(primary.score)}, ${margin} from the boundary.`,
        `判定阈值是 0.500，初检分数为 ${number(primary.score)}，相距 ${margin}。`), "evaluate_review_policy");
    }
    if (topic === "review") {
      const lines = [status === "review" ? say("Human review was suggested.", "这条记录建议人工复核。")
        : say("This run did not flag the image for human review.", "这条记录没有要求人工复核。")];
      if (reasons.includes("near_decision_threshold") && policy) lines.push(say(
        `The score was ${number(policy.score_margin)} from 0.500, within the ${number(policy.maximum_borderline_margin)} review margin.`,
        `分数距 0.500 只有 ${number(policy.score_margin)}，落在 ${number(policy.maximum_borderline_margin)} 的复核范围内。`));
      if (reasons.includes("expert_disagreement") && policy) lines.push(say(
        `The expert vote spread was ${number(policy.expert_vote_spread)}, meeting the ${number(policy.minimum_disagreement)} review threshold.`,
        `专家打分相差 ${number(policy.expert_vote_spread)}，达到了 ${number(policy.minimum_disagreement)} 的复核门槛。`));
      if (reasons.includes("verdict_changed_after_recompression") && check) lines.push(say(
        `The JPEG pass changed the verdict from ${verdict(primary.label)} to ${verdict(check.label)}.`,
        `JPEG 复测让判定从「${verdict(primary.label)}」变为「${verdict(check.label)}」。`));
      if (reasons.includes("recheck_failed")) lines.push(say("The JPEG recheck failed; the initial result was preserved.", "JPEG 复测失败，初检结果仍保留。"));
      return result(lines.join(" "), "evaluate_review_policy", "finalize_review");
    }
    if (topic === "score") return result(say(
      `Initial result: ${score(primary)}. This score is not a probability or proof of origin.`,
      `初检结果：${score(primary)}。这是模型打分，不能当作概率或图像来源的证明。`), "duet_primary");
    return result(say("I can explain review decisions, compare JPEG scores, show the model route or expert votes, and export this record.",
      "我可以解释为什么复核、对比 JPEG 分数、查看模型路径和各层专家打分，或导出这条记录。"));
  }
  return {answer, intent, useChinese, stepLabel, stepZh};
})();

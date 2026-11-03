/**
 * Branch Discussion — let the agent fork a *soft* branch of the conversation.
 *
 * Difference from the built-in Branch action: that one hard-forks a Session and
 * the UI switches to it. Here the parent keeps running: a child Agent is seeded
 * with the parent's history up to (but excluding) the assistant output of the
 * step in flight, discusses one sub-question there, and returns a bounded
 * structured digest. The child's exploration never enters the parent log.
 *
 * Why a custom subagent provider: the stock `fork` provider seeds only the
 * prefix of the last completed `turn/end`, so a child started mid-turn cannot
 * see the current user request or the tool results the parent already produced.
 * This provider cuts before the in-flight assistant output instead, then closes
 * the open tail the same way `@deepseek-ai/dsh-session` does (`buildForkSeed`).
 *
 * @module @local/branch-discussion
 */

const name = "branch-discussion";
const inject = ["subagents", "tools", "systemPrompt", "commands"];

const TOOL_NAME = "branch_discuss";
const COMMAND_NAME = "branch";
const DEFAULT_PROVIDER = "branch";

/** Defaults mirrored in the `config` entry that installs the plugin. */
const DEFAULTS = Object.freeze({
	provider: DEFAULT_PROVIDER,
	/** How long `branch_discuss` (mode `wait`) blocks before returning "still running". */
	timeoutMs: 600_000,
	/** Soft cap on the rendered digest, in characters. Keeps the parent's context ~<=400 tokens. */
	digestChars: 1_600,
	/** Register the `/branch` slash command. */
	command: true
});

/**
 * Model-visible wording of synthetic error tool results. Mirrors CLOSER_TEXT in
 * @deepseek-ai/dsh-session so a seeded child renders exactly like a stock fork.
 */
const CLOSER_TEXT = Object.freeze({
	forked: Object.freeze({
		started: "The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.",
		notStarted: "The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly."
	})
});

// ---------------------------------------------------------------------------
// Pure: where to cut the parent's log
// ---------------------------------------------------------------------------

/**
 * Inclusive source-event index the child inherits through.
 *
 * The cut keeps the parent's completed turns, the current turn's input
 * (`user/message` and friends), and every step whose tool results are already
 * committed. It drops the assistant output of the step in flight — including
 * the tool call that started this branch and any sibling calls running beside
 * it — because those results do not exist yet.
 *
 * @param events - the parent's committed events, seqs contiguous from zero.
 * @returns The inclusive boundary index, or -1 when there is nothing to inherit.
 */
function branchBoundary(events) {
	const last = events.length - 1;
	if (last < 0) return -1;
	let openTurn = false;
	let lastAssistant = -1;
	for (let index = 0; index <= last; index += 1) {
		const type = events[index].type;
		if (type === "turn/start") {
			openTurn = true;
			lastAssistant = -1;
		} else if (type === "turn/end") {
			openTurn = false;
			lastAssistant = -1;
		} else if (type === "assistant/message" && openTurn) lastAssistant = index;
	}
	// Between turns (or with no assistant output yet) the whole log is settled.
	if (!openTurn || lastAssistant < 0) return last;
	let boundary = lastAssistant - 1;
	// A trailing `step/start` with no output belongs to the in-flight step: the
	// step began before its request was injected, so keep the request itself.
	while (boundary >= 0 && events[boundary].type === "step/start") boundary -= 1;
	return boundary;
}

// ---------------------------------------------------------------------------
// Pure: fork seed construction (port of @deepseek-ai/dsh-session buildForkSeed)
// ---------------------------------------------------------------------------

/** Track unanswered assistant tool requests across one prefix. */
function recoveryResults(prefix) {
	const pending = new Map();
	let last;
	for (const event of prefix) {
		last = { seq: event.seq, time: event.time };
		switch (event.type) {
			case "turn/start":
			case "turn/end":
			case "step/end":
				pending.clear();
				break;
			case "assistant/message": {
				const content = event.data?.message?.content;
				if (Array.isArray(content)) for (const block of content) {
					if (block !== null && typeof block === "object" && block.type === "tool-call") pending.set(block.id, {
						turn: event.data.turn,
						step: event.data.step
					});
				}
				break;
			}
			case "tool/call": {
				const entry = pending.get(event.data?.callId);
				if (entry !== undefined) entry.callSeq = event.seq;
				break;
			}
			case "tool/result": {
				const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId;
				const entry = pending.get(callId);
				if (entry !== undefined && entry.turn === event.data?.turn && entry.step === event.data?.step) pending.delete(callId);
				break;
			}
			default: break;
		}
	}
	if (last === undefined) return [];
	const text = CLOSER_TEXT.forked;
	const results = [];
	let seq = last.seq + 1;
	for (const [callId, entry] of pending) {
		const started = entry.callSeq !== undefined;
		results.push({
			type: "tool/result",
			seq: seq++,
			time: last.time,
			data: {
				turn: entry.turn,
				step: entry.step,
				message: {
					id: `forked-tool-result-${callId}-${seq}`,
					role: "tool",
					toolCallId: callId,
					isError: true,
					source: {
						kind: "tool",
						callId
					},
					content: [{
						type: "text",
						text: started ? text.started : text.notStarted
					}]
				},
				error: started ? {
					name: "ToolOutcomeUnknownError",
					code: "TOOL_OUTCOME_UNKNOWN"
				} : {
					name: "ToolNotStartedError",
					code: "TOOL_NOT_STARTED"
				}
			},
			surfaceOp: "append",
			...started ? { sourceEventSeqs: [entry.callSeq] } : {}
		});
	}
	return results;
}

/** Synthetic events that balance an open tail turn with the `forked` cause. */
function forkClosers(prefix) {
	let openTurn = null;
	let openStep = null;
	for (const event of prefix) {
		switch (event.type) {
			case "turn/start":
				openTurn = event.data?.turn;
				openStep = null;
				break;
			case "turn/end":
				openTurn = null;
				openStep = null;
				break;
			case "step/start":
				openStep = event.data?.step;
				break;
			case "step/end":
				openStep = null;
				break;
			default: break;
		}
	}
	const last = prefix.at(-1);
	if (openTurn === null || last === undefined) return [];
	const closers = recoveryResults(prefix);
	let seq = last.seq + closers.length + 1;
	if (openStep !== null) closers.push({
		type: "step/end",
		seq: seq++,
		time: last.time,
		data: {
			turn: openTurn,
			step: openStep
		}
	});
	closers.push({
		type: "turn/end",
		seq: seq++,
		time: last.time,
		data: {
			turn: openTurn,
			reason: { kind: "forked" }
		}
	});
	return closers;
}

/**
 * Copy an inclusive prefix, mark its inherited cut, and close its open tail.
 * @param events - source events with contiguous seqs.
 * @param boundary - inclusive source seq to inherit through.
 * @returns seed events for `agents.create`.
 */
function buildSeed(events, boundary) {
	const prefix = events.slice(0, boundary + 1);
	prefix.push({
		type: "session/end-seed",
		seq: boundary + 1,
		time: events[boundary].time,
		data: { inherited: true }
	});
	return prefix.concat(forkClosers(prefix));
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * In-process continuable subagent provider that seeds each child with the
 * parent's log cut at the branch point. Mirrors @deepseek-ai/dsh-subagent-fork-in-process,
 * except for the cut.
 */
class BranchProvider {
	name;
	capabilities = {
		agentOptions: true,
		agentPreset: false,
		outputSchema: true,
		depthLimit: true
	};
	inheritsParentContext = true;

	constructor(providerName) {
		this.name = providerName;
	}

	/**
	 * @param request - { parent } for one continuable child creation.
	 * @returns `{ seed }`, or `{}` when there is no parent history to inherit.
	 */
	prepareContinuable(request) {
		const events = request.parent.session.snapshotEvents();
		const boundary = branchBoundary(events);
		if (boundary < 0) return Promise.resolve({});
		return Promise.resolve({ seed: buildSeed(events, boundary) });
	}
}

// ---------------------------------------------------------------------------
// Structured digest contract
// ---------------------------------------------------------------------------

/** What the child must submit through its `structured_output` tool. */
const DIGEST_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	properties: {
		conclusion: {
			type: "string",
			description: "The answer to the branch question, at most 80 words. No preamble."
		},
		confidence: {
			type: "string",
			enum: ["high", "medium", "low"],
			description: "How well the evidence supports the conclusion."
		},
		evidence: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					claim: {
						type: "string",
						description: "One finding, at most 30 words."
					},
					source: {
						type: "string",
						description: "Where it came from: path:line, a command, or `inference`."
					}
				},
				required: ["claim", "source"]
			},
			description: "At most 6 findings you actually verified."
		},
		recommendation: {
			type: "string",
			description: "What the parent should do next, at most 60 words."
		},
		rejected_options: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					option: { type: "string" },
					why_not: { type: "string" }
				},
				required: ["option", "why_not"]
			},
			description: "Options considered and dropped, with the reason. At most 4."
		},
		open_questions: {
			type: "array",
			items: { type: "string" },
			description: "What could not be settled here. At most 5."
		}
	},
	required: ["conclusion", "confidence", "evidence", "recommendation"]
});

/** Bound every digest field so the parent's context grows by a fixed amount. */
function clampDigest(value, digestChars = DEFAULTS.digestChars) {
	const limit = Math.max(400, digestChars);
	const budget = {
		conclusion: Math.round(limit * 0.4),
		recommendation: Math.round(limit * 0.25)
	};
	const clip = (text, max) => {
		const value = typeof text === "string" ? text.trim() : "";
		return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
	};
	const digest = {
		conclusion: clip(value?.conclusion, budget.conclusion),
		confidence: ["high", "medium", "low"].includes(value?.confidence) ? value.confidence : "low",
		evidence: [],
		recommendation: clip(value?.recommendation, budget.recommendation),
		rejected_options: [],
		open_questions: []
	};
	const evidence = Array.isArray(value?.evidence) ? value.evidence.slice(0, 6) : [];
	for (const item of evidence) {
		if (item === null || typeof item !== "object") continue;
		digest.evidence.push({
			claim: clip(item.claim, 220),
			source: clip(item.source, 160)
		});
		if (digest.evidence.length >= 6) break;
	}
	const rejected = Array.isArray(value?.rejected_options) ? value.rejected_options.slice(0, 4) : [];
	for (const item of rejected) {
		if (item === null || typeof item !== "object") continue;
		digest.rejected_options.push({
			option: clip(item.option, 120),
			why_not: clip(item.why_not, 160)
		});
		if (digest.rejected_options.length >= 4) break;
	}
	const open = Array.isArray(value?.open_questions) ? value.open_questions.slice(0, 5) : [];
	for (const item of open) {
		if (typeof item !== "string") continue;
		digest.open_questions.push(clip(item, 160));
		if (digest.open_questions.length >= 5) break;
	}
	return digest;
}

/** Flatten the child's final assistant text when it never called `structured_output`. */
function outputText(output) {
	if (!Array.isArray(output)) return "";
	return output.filter((block) => block !== null && typeof block === "object" && block.type === "text").map((block) => block.text).join("\n").trim();
}

/** Render one digest as compact model-facing text. */
function renderDigest(digest, childId) {
	const lines = [`Branch conclusion (sub-session ${childId}):`, digest.conclusion, `Confidence: ${digest.confidence}`];
	if (digest.recommendation !== "") lines.push(`Recommendation: ${digest.recommendation}`);
	if (digest.evidence.length > 0) {
		lines.push("Evidence:");
		for (const item of digest.evidence) lines.push(`- ${item.claim} (${item.source})`);
	}
	if (digest.rejected_options.length > 0) {
		lines.push("Rejected:");
		for (const item of digest.rejected_options) lines.push(`- ${item.option} — ${item.why_not}`);
	}
	if (digest.open_questions.length > 0) {
		lines.push("Still open:");
		for (const item of digest.open_questions) lines.push(`- ${item}`);
	}
	lines.push("The branch's own exploration is not in this conversation; open the sub-session from the parent header to inspect or continue it.");
	return lines.join("\n");
}

/** Render a plain-text fallback when the child answered without the structured tool. */
function renderFallback(text, childId, digestChars = DEFAULTS.digestChars) {
	const body = typeof text === "string" ? text.trim() : "";
	const clipped = body.length <= digestChars ? body : `${body.slice(0, Math.max(1, digestChars - 1))}…`;
	return `Branch answer (sub-session ${childId}, unstructured):\n${clipped === "" ? "(the child produced no text)" : clipped}`;
}

// ---------------------------------------------------------------------------
// Prompt material
// ---------------------------------------------------------------------------

/** Parent-side guidance: when to branch, and how to write the question. */
const SECTION_TEXT = `## Branch discussion (\`branch_discuss\`)

When a sub-question is worth isolating — an investigation, a comparison, a hypothesis that needs several tool calls — prefer a branch over burning this conversation on it. The child inherits this conversation up to the start of your current step (your own in-flight reasoning is not visible to it), explores on its own, and returns a bounded structured digest. Its tool calls and intermediate output never enter this log.

Branch when: the answer does not depend on an edit you are about to make; you expect five or more tool calls; the question is self-contained enough to state in one paragraph; the result can compress to a page; or the question is off-topic relative to the main task and needs an external lookup or more than one check. Do not branch when: one file read or one command settles it; you can already answer it from what you know; you need the user to decide something; the answer must quote exact wording from here; the task is itself an implementation change.

An answer you already hold is not a branch — answer it. But do not spend inline web searches, log digging, or multi-step checks on a sub-question that is unrelated to the main task: that is exactly the case this tool exists for, and the observations stay out of this log if you branch.

Rules for the question: it must stand alone, because the child does not see your current reasoning — include what you already ruled out. State the question, not the plan. On return, answer the user from the digest; do not replay the child's steps.

Context hygiene around a branch. (1) State the conclusion in your reply before moving on: a digest you never restated is the first thing lost when the log is later compacted. (2) Long findings belong in a file or the digest itself, not in a tool result you intend to rely on tomorrow. (3) Prevention beats cleanup: branching up front costs one page; cleaning up afterwards costs a summary of a summary. (4) Do not compact the session yourself on top of a compression layer that already owns it (a wire-level proxy such as billion-context/ACP) — that yields double compression and a stale substrate; this plugin only keeps new pollution out.

中文说明：当子问题值得单独隔离（调研、对比、验证假设、预计多次工具调用）时用 \`branch_discuss\` 开分支，子代理在继承到"当前 step 之前"的上下文里讨论，只把一页以内的结构化摘要带回主上下文；分支里的工具调用与过程不进本会话日志。一次读文件就能定的事、需要用户拍板的事、要逐字引用的内容、以及本身就要改代码的活，不要开分支。已经知道答案的问题直接回答；但**与主任务无关、又需要联网检索或多次核对**的问题应当开分支，而不是在主上下文里直接搜索。分支回来先把结论写进回复再继续（没复述的摘要，压缩时最先丢），长结论落文件而不是留在工具结果里。`;

/**
 * Child-facing instruction. The seed already carries the parent's request, so
 * this only scopes the work and states the output contract.
 */
function buildChildPrompt(args) {
	const focus = Array.isArray(args.focus) ? args.focus.filter((item) => typeof item === "string" && item.trim() !== "") : [];
	const lines = [
		"You are a branch of a parent conversation, running as a child session. The inherited history ends just before the parent's in-flight step: it contains the parent's request and every tool result the parent had completed at the fork point, but not the parent's current reasoning or the other tool calls running beside this one.",
		"",
		"Branch question:",
		args.question,
		""
	];
	if (focus.length > 0) {
		lines.push("What the parent especially wants checked:");
		for (const item of focus) lines.push(`- ${item}`);
		lines.push("");
	}
	lines.push(
		"Rules:",
		"1. Answer only this question. Do not expand into the parent's broader task.",
		"2. Treat the workspace as shared and being edited concurrently: read, search, and run read-only commands. Do not modify files, install packages, or run state-changing commands.",
		"3. Ground every claim in something you actually observed. Put `path:line`, the command you ran, or `inference` in each evidence source. Never invent file contents.",
		"4. Keep conclusion under 80 words, evidence to at most 6 items of at most 30 words each, recommendation under 60 words.",
		"5. Finish by calling `structured_output` exactly once with the digest fields. The run ends after it; do not call anything else afterwards.",
		"6. If the question cannot be answered from this workspace, say so in conclusion and put the blocker in open_questions instead of guessing."
	);
	return lines.join("\n");
}

/** Display label for the child (short, derived from the question). */
function labelOf(args) {
	const label = typeof args.label === "string" ? args.label.trim() : "";
	if (label !== "") return label.slice(0, 40);
	const question = typeof args.question === "string" ? args.question.trim().replace(/\s+/g, " ") : "";
	return question.length <= 40 ? question : `${question.slice(0, 39)}…`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * @param ctx - context carrying subagents, tools, systemPrompt, and commands.
 * @param config - { provider?, timeoutMs?, digestChars?, command? }.
 */
function apply(ctx, config = {}) {
	const options = {
		provider: typeof config.provider === "string" && config.provider.trim() !== "" ? config.provider.trim() : DEFAULTS.provider,
		timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULTS.timeoutMs,
		digestChars: Number.isFinite(config.digestChars) && config.digestChars >= 400 ? config.digestChars : DEFAULTS.digestChars,
		command: config.command !== false
	};

	ctx.subagents.registerProvider(new BranchProvider(options.provider));

	/**
	 * Start one branch child. Errors are returned, never thrown, so both callers
	 * can render them without losing the child id.
	 */
	async function startBranch(parent, args, signal, delivery) {
		const subagents = ctx.subagents;
		if (subagents.getProvider(options.provider) === undefined) return {
			error: `branch provider "${options.provider}" is not registered; enable @deepseek-ai/dsh-subagent in this profile`
		};
		const request = {
			parent,
			prompt: [{
				type: "text",
				text: buildChildPrompt(args)
			}],
			outputSchema: DIGEST_SCHEMA
		};
		try {
			const receipt = await subagents.startActivation({
				provider: options.provider,
				label: labelOf(args),
				request,
				signal,
				delivery
			});
			return { receipt };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Wait for a branch result without ever rejecting, and without leaking a rejection. */
	function waitFor(receipt, signal) {
		const raced = Promise.race([
			receipt.result.then((value) => ({
				kind: "result",
				value
			}), (error) => ({
				kind: "error",
				error
			})),
			new Promise((resolve) => {
				if (signal?.aborted === true) {
					resolve({ kind: "aborted" });
					return;
				}
				const timer = setTimeout(() => resolve({ kind: "timeout" }), options.timeoutMs);
				if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") timer.unref();
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve({ kind: "aborted" });
				}, { once: true });
			})
		]);
		return raced;
	}

	ctx.tools.register({
		name: TOOL_NAME,
		description: [
			"Discuss one self-contained sub-question in a child session that inherits this conversation up to the start of your current step, then return a bounded structured digest. Use it to keep an investigation, comparison, or hypothesis out of this log; the child's tool calls never enter here.",
			"Mode `wait` (default) returns the digest as this tool result. Mode `async` starts the child and returns immediately; its completion notice arrives as a later turn.",
			"The child shares this workspace and runs with approval disabled, so it is for reading and reasoning, never for edits."
		].join(" "),
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["question"],
			properties: {
				question: {
					type: "string",
					description: "The sub-question, self-contained: the child cannot see your current reasoning, so name what you already ruled out."
				},
				focus: {
					type: "array",
					items: { type: "string" },
					description: "Specific things the child should check, compare, or verify."
				},
				mode: {
					type: "string",
					enum: ["wait", "async"],
					description: "`wait` blocks for the digest (default); `async` returns a child id immediately."
				},
				label: {
					type: "string",
					description: "Short display label for the sub-session. Defaults to the question."
				}
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["status"],
				properties: {
					status: {
						type: "string",
						enum: ["completed", "text_only", "started", "timeout", "error"]
					},
					child_session_id: { type: "string" },
					message: { type: "string" },
					conclusion: { type: "string" },
					confidence: {
						type: "string",
						enum: ["high", "medium", "low"]
					},
					recommendation: { type: "string" },
					evidence: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["claim", "source"],
							properties: {
								claim: { type: "string" },
								source: { type: "string" }
							}
						}
					},
					rejected_options: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["option", "why_not"],
							properties: {
								option: { type: "string" },
								why_not: { type: "string" }
							}
						}
					},
					open_questions: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => [{ type: "text", text: value.message ?? "" }]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const parent = exec.agent;
			if (parent === undefined || parent.session === undefined) return {
				status: "error",
				message: "branch_discuss requires a calling agent with a live session."
			};
			if (args.mode === "async") {
				const started = await startBranch(parent, args, exec.signal, "parent");
				if (started.error !== undefined) return {
					status: "error",
					message: started.error
				};
				return {
					status: "started",
					child_session_id: started.receipt.childId,
					message: `Branch started as ${started.receipt.childId}. Its digest will arrive as a later turn; meanwhile continue on the main task.`
				};
			}
			const started = await startBranch(parent, args, exec.signal, "caller");
			if (started.error !== undefined) return {
				status: "error",
				message: started.error
			};
			const receipt = started.receipt;
			const settled = await waitFor(receipt, exec.signal);
			if (settled.kind === "timeout") return {
				status: "timeout",
				child_session_id: receipt.childId,
				message: `Branch ${receipt.childId} is still running after ${Math.round(options.timeoutMs / 1000)}s. It will not report back on its own; open the sub-session from the parent header to read or continue it.`
			};
			if (settled.kind === "aborted") {
				await receipt.dispose().catch(() => void 0);
				return {
					status: "error",
					child_session_id: receipt.childId,
					message: "Branch cancelled with this turn."
				};
			}
			if (settled.kind === "error") return {
				status: "error",
				child_session_id: receipt.childId,
				message: `Branch failed: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`
			};
			const result = settled.value;
			if (result.stopReason !== "completed") return {
				status: "error",
				child_session_id: receipt.childId,
				message: `Branch ended with stop reason "${result.stopReason}"; nothing reliable came back. Its log stays available in the sub-session header.`
			};
			if (result.structured !== undefined) {
				const digest = clampDigest(result.structured, options.digestChars);
				return {
					status: "completed",
					child_session_id: receipt.childId,
					message: renderDigest(digest, receipt.childId),
					conclusion: digest.conclusion,
					confidence: digest.confidence,
					recommendation: digest.recommendation,
					evidence: digest.evidence,
					rejected_options: digest.rejected_options,
					open_questions: digest.open_questions
				};
			}
			return {
				status: "text_only",
				child_session_id: receipt.childId,
				message: renderFallback(outputText(result.output), receipt.childId, options.digestChars)
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Branch discussion",
			kind: "other",
			...(typeof args.question === "string" ? { rawInput: args.question.slice(0, 120) } : {})
		})
	});

	ctx.systemPrompt.section({
		name: "tool:branch-discussion",
		order: 2860,
		text: SECTION_TEXT
	});

	if (options.command) ctx.commands.register({
		name: COMMAND_NAME,
		description: "讨论一个子问题并把结论留在命令面板（不进主上下文）",
		input: { hint: "<子问题> [--async]" },
		handler: async ({ agent, rawInput, signal }) => {
			let question = typeof rawInput === "string" ? rawInput.trim() : "";
			let mode = "wait";
			const asyncSuffix = /\s--async$/;
			if (asyncSuffix.test(question)) {
				mode = "async";
				question = question.replace(asyncSuffix, "").trim();
			}
			if (question === "") return {
				kind: "error",
				text: "用法：/branch <子问题> [--async]。子问题必须自包含。"
			};
			const args = {
				question,
				focus: [],
				mode
			};
			if (mode === "async") {
				const started = await startBranch(agent, args, signal, "parent");
				if (started.error !== undefined) return {
					kind: "error",
					text: started.error
				};
				return {
					kind: "success",
					text: `已在分支中开始：${started.receipt.childId}。完成后会作为新的一轮回到主线程。`
				};
			}
			const started = await startBranch(agent, args, signal, "caller");
			if (started.error !== undefined) return {
				kind: "error",
				text: started.error
			};
			const receipt = started.receipt;
			const settled = await waitFor(receipt, signal);
			if (settled.kind === "timeout") return {
				kind: "success",
				text: `分支 ${receipt.childId} 仍在进行（超过 ${Math.round(options.timeoutMs / 1000)} 秒）。它不会自己回报；可在父会话页头展开该子会话读取或继续。`
			};
			if (settled.kind === "aborted") {
				await receipt.dispose().catch(() => void 0);
				return {
					kind: "error",
					text: "分支讨论已取消。"
				};
			}
			if (settled.kind === "error") return {
				kind: "error",
				text: `分支失败：${settled.error instanceof Error ? settled.error.message : String(settled.error)}`
			};
			const result = settled.value;
			if (result.structured !== undefined) return {
				kind: "success",
				text: renderDigest(clampDigest(result.structured, options.digestChars), receipt.childId)
			};
			if (result.stopReason === "completed") return {
				kind: "success",
				text: renderFallback(outputText(result.output), receipt.childId, options.digestChars)
			};
			return {
				kind: "error",
				text: `分支以 "${result.stopReason}" 结束，没有可靠结论。可展开子会话 ${receipt.childId} 查看。`
			};
		}
	});
}

export {
	apply,
	branchBoundary,
	buildSeed,
	BranchProvider,
	clampDigest,
	DIGEST_SCHEMA,
	forkClosers,
	inject,
	name,
	outputText,
	renderDigest,
	renderFallback
};

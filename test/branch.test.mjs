import assert from "node:assert/strict";
import test from "node:test";
import {
	apply,
	branchBoundary,
	BranchProvider,
	buildSeed,
	clampDigest,
	DIGEST_SCHEMA,
	forkClosers,
	inject,
	name,
	outputText,
	renderDigest,
	renderFallback
} from "../index.js";

/** Build a log with contiguous seqs, the way `session.snapshotEvents()` yields it. */
function log(entries) {
	let seq = 0;
	return entries.map(([type, data]) => ({
		type,
		seq: seq++,
		time: 1_000 + seq,
		data
	}));
}

const userMessage = ["user/message", {
	turn: 1,
	message: {
		id: "u1",
		role: "user",
		content: [{
			type: "text",
			text: "investigate the cache path"
		}]
	}
}];

const assistantCall = (id, turn = 1, step = 1) => ["assistant/message", {
	turn,
	step,
	message: {
		id: `a-${id}`,
		role: "assistant",
		content: [{
			type: "tool-call",
			id,
			name: "bash",
			arguments: { command: "ls" }
		}]
	}
}];

const toolResult = (id, turn = 1, step = 1) => ["tool/result", {
	turn,
	step,
	message: {
		id: `r-${id}`,
		role: "tool",
		toolCallId: id,
		isError: false,
		source: {
			kind: "tool",
			callId: id
		},
		content: [{
			type: "text",
			text: "ok"
		}]
	}
}];

test("branchBoundary keeps the current request and drops the in-flight assistant step", () => {
	const events = log([
		["turn/start", { turn: 1 }],
		["step/start", {
			turn: 1,
			step: 1
		}],
		userMessage,
		assistantCall("c1"),
		["tool/call", {
			turn: 1,
			step: 1,
			callId: "c1",
			name: "bash",
			args: { command: "ls" }
		}]
	]);
	assert.equal(branchBoundary(events), 2);
	assert.equal(events[branchBoundary(events)].type, "user/message");
});

test("branchBoundary cuts before a later step's request, keeping earlier tool results", () => {
	const events = log([
		["turn/start", { turn: 1 }],
		["step/start", {
			turn: 1,
			step: 1
		}],
		userMessage,
		assistantCall("a"),
		["tool/call", {
			turn: 1,
			step: 1,
			callId: "a",
			name: "bash",
			args: {}
		}],
		toolResult("a"),
		["step/end", {
			turn: 1,
			step: 1
		}],
		["step/start", {
			turn: 1,
			step: 2
		}],
		assistantCall("b", 1, 2),
		["tool/call", {
			turn: 1,
			step: 2,
			callId: "b",
			name: "bash",
			args: {}
		}]
	]);
	const boundary = branchBoundary(events);
	assert.equal(boundary, 6);
	assert.equal(events[boundary].type, "step/end");
});

test("branchBoundary inherits the whole log between turns", () => {
	const events = log([
		["turn/start", { turn: 1 }],
		["step/start", {
			turn: 1,
			step: 1
		}],
		userMessage,
		assistantCall("a"),
		["tool/call", {
			turn: 1,
			step: 1,
			callId: "a",
			name: "bash",
			args: {}
		}],
		toolResult("a"),
		["step/end", {
			turn: 1,
			step: 1
		}],
		["turn/end", {
			turn: 1,
			reason: { kind: "completed" }
		}]
	]);
	assert.equal(branchBoundary(events), events.length - 1);
	assert.equal(branchBoundary([]), -1);
});

test("branchBoundary keeps a fresh step's request even before the assistant answers", () => {
	const events = log([
		["turn/start", { turn: 1 }],
		["step/start", {
			turn: 1,
			step: 1
		}],
		userMessage
	]);
	assert.equal(branchBoundary(events), 2);
});

/** Tool-call ids a seeded log refers to but that no earlier call opened. */
function orphanToolResults(events) {
	const calls = new Set();
	const orphans = [];
	for (const event of events) {
		if (event.type === "assistant/message") {
			for (const block of event.data.message.content ?? []) {
				if (block !== null && typeof block === "object" && block.type === "tool-call") calls.add(block.id);
			}
		} else if (event.type === "tool/call") {
			calls.add(event.data.callId);
		} else if (event.type === "tool/result") {
			const callId = event.data.message.toolCallId;
			if (!calls.has(callId)) orphans.push(callId);
		}
	}
	return orphans;
}

test("the cut never splits a tool call from its result, at any step depth", () => {
	// Three completed steps, then an in-flight one: every carried-over result
	// must still have its call inside the prefix, and every open call must be
	// recovered — a compaction-style "balanced cut" applied to fork seeds.
	const deep = log([
		["turn/start", { turn: 1 }],
		["step/start", {
			turn: 1,
			step: 1
		}],
		userMessage,
		assistantCall("a", 1, 1),
		["tool/call", {
			turn: 1,
			step: 1,
			callId: "a",
			name: "bash",
			args: {}
		}],
		toolResult("a", 1, 1),
		["step/end", {
			turn: 1,
			step: 1
		}],
		["step/start", {
			turn: 1,
			step: 2
		}],
		assistantCall("b", 1, 2),
		["tool/call", {
			turn: 1,
			step: 2,
			callId: "b",
			name: "bash",
			args: {}
		}],
		toolResult("b", 1, 2),
		["step/end", {
			turn: 1,
			step: 2
		}],
		["step/start", {
			turn: 1,
			step: 3
		}],
		assistantCall("c", 1, 3),
		["tool/call", {
			turn: 1,
			step: 3,
			callId: "c",
			name: "bash",
			args: {}
		}]
	]);
	const boundary = branchBoundary(deep);
	assert.equal(deep[boundary].type, "step/end");
	const seed = buildSeed(deep, boundary);
	assert.deepEqual(orphanToolResults(seed), []);
	assert.equal(seed[seed.length - 1].type, "turn/end");
	// The prefix still carries both completed pairs verbatim.
	assert.equal(seed.filter((event) => event.type === "tool/result").length, 2);
	// Seqs stay contiguous from 0 and the cut marker sits right after it.
	seed.forEach((event, index) => assert.equal(event.seq, index));
	assert.equal(seed[boundary + 1].type, "session/end-seed");
});

test("buildSeed marks the inherited cut, recovers open calls, and closes the fork", () => {
	const events = log([
		["turn/start", { turn: 1 }],
		["step/start", {
			turn: 1,
			step: 1
		}],
		userMessage,
		assistantCall("c1"),
		["tool/call", {
			turn: 1,
			step: 1,
			callId: "c1",
			name: "bash",
			args: {}
		}]
	]);
	const boundary = 4;
	const seed = buildSeed(events, boundary);
	assert.equal(seed.length, 5 + 1 + 3);
	assert.deepEqual(seed.slice(0, 5), events.slice(0, 5));
	assert.equal(seed[5].type, "session/end-seed");
	assert.equal(seed[5].data.inherited, true);
	assert.equal(seed[5].seq, boundary + 1);
	const recovered = seed[6];
	assert.equal(recovered.type, "tool/result");
	assert.equal(recovered.data.message.toolCallId, "c1");
	assert.equal(recovered.data.message.isError, true);
	assert.equal(recovered.data.error.code, "TOOL_OUTCOME_UNKNOWN");
	assert.equal(recovered.surfaceOp, "append");
	assert.deepEqual(recovered.sourceEventSeqs, [4]);
	assert.match(recovered.data.message.content[0].text, /inherited by this branch records this tool call starting/);
	assert.deepEqual(seed.slice(7).map((event) => event.type), ["step/end", "turn/end"]);
	assert.deepEqual(seed.at(-1).data.reason, { kind: "forked" });
	for (const [index, event] of seed.entries()) assert.equal(event.seq, index);
});

test("forkClosers reports a call that never started", () => {
	const prefix = log([
		["turn/start", { turn: 1 }],
		["step/start", {
			turn: 1,
			step: 1
		}],
		assistantCall("ghost")
	]);
	const closers = forkClosers(prefix);
	assert.equal(closers[0].data.error.code, "TOOL_NOT_STARTED");
	assert.match(closers[0].data.message.content[0].text, /has no record of this tool call starting/);
	assert.deepEqual(closers.map((event) => event.type), ["tool/result", "step/end", "turn/end"]);
});

test("BranchProvider seeds from the parent's cut", async () => {
	const events = log([
		["turn/start", { turn: 1 }],
		["step/start", {
			turn: 1,
			step: 1
		}],
		userMessage,
		assistantCall("c1")
	]);
	const provider = new BranchProvider("branch");
	assert.equal(provider.name, "branch");
	assert.equal(provider.inheritsParentContext, true);
	const prepared = await provider.prepareContinuable({
		parent: { session: { snapshotEvents: () => events } }
	});
	assert.equal(prepared.seed[prepared.seed.length - 1].type, "turn/end");
	assert.equal(prepared.seed.at(-1).data.reason.kind, "forked");
});

test("clampDigest bounds every field and defaults unknown confidence", () => {
	const long = "x".repeat(5_000);
	const digest = clampDigest({
		conclusion: long,
		confidence: "certain",
		evidence: Array.from({ length: 9 }, () => ({
			claim: long,
			source: long
		})),
		recommendation: long,
		rejected_options: Array.from({ length: 7 }, () => ({
			option: long,
			why_not: long
		})),
		open_questions: Array.from({ length: 8 }, () => long)
	}, 1_600);
	assert.ok(digest.conclusion.length <= 640);
	assert.ok(digest.recommendation.length <= 400);
	assert.equal(digest.confidence, "low");
	assert.equal(digest.evidence.length, 6);
	assert.ok(digest.evidence[0].claim.length <= 220);
	assert.ok(digest.evidence[0].source.length <= 160);
	assert.equal(digest.rejected_options.length, 4);
	assert.equal(digest.open_questions.length, 5);
	assert.ok(clampDigest({ conclusion: "short", confidence: "high", evidence: [], recommendation: "go" }).conclusion === "short");
});

test("renderers produce compact model-facing text", () => {
	const digest = clampDigest({
		conclusion: "the cache is keyed by turn",
		confidence: "high",
		evidence: [{
			claim: "key includes turn",
			source: "src/cache.ts:12"
		}],
		recommendation: "key by step",
		rejected_options: [{
			option: "drop cache",
			why_not: "too slow"
		}],
		open_questions: []
	});
	const text = renderDigest(digest, "child-7");
	assert.match(text, /child-7/);
	assert.match(text, /src\/cache\.ts:12/);
	assert.equal(outputText([{
		type: "text",
		text: "hello"
	}, { type: "reasoning", text: "x" }, {
		type: "text",
		text: "world"
	}]), "hello\nworld");
	assert.match(renderFallback("  done  ", "child-8", 100), /done/);
});

/** A context that records registrations, enough to exercise `apply` wiring. */
function fakeContext() {
	const state = {
		providers: [],
		tools: [],
		sections: [],
		commands: []
	};
	const ctx = {
		subagents: {
			registerProvider(provider) {
				state.providers.push(provider);
			},
			getProvider(providerName) {
				return state.providers.find((provider) => provider.name === providerName);
			},
			startActivation: async () => ({})
		},
		tools: {
			register(definition) {
				state.tools.push(definition);
			}
		},
		systemPrompt: {
			section(definition) {
				state.sections.push(definition);
			}
		},
		commands: {
			register(definition) {
				state.commands.push(definition);
			}
		}
	};
	return { ctx, state };
}

test("apply registers the provider, tool, prompt section, and command", () => {
	const { ctx, state } = fakeContext();
	apply(ctx, {});
	assert.equal(name, "branch-discussion");
	assert.deepEqual(inject, ["subagents", "tools", "systemPrompt", "commands"]);
	assert.equal(state.providers[0].name, "branch");
	assert.equal(state.tools[0].name, "branch_discuss");
	// The runtime hands `parameters` to the model provider verbatim, so it must
	// be a complete object-rooted JSON Schema, not a property map.
	assert.equal(state.tools[0].parameters.type, "object");
	assert.deepEqual(Object.keys(state.tools[0].parameters.properties), ["question", "focus", "mode", "label"]);
	assert.deepEqual(state.tools[0].parameters.required, ["question"]);
	assert.equal(state.tools[0].parameters.additionalProperties, false);
	assert.equal(state.tools[0].isConcurrencySafe(), true);
	assert.equal(state.sections[0].name, "tool:branch-discussion");
	assert.equal(state.sections[0].order, 2860);
	assert.equal(state.commands[0].name, "branch");
});

test("apply honours config: provider name and command opt-out", () => {
	const { ctx, state } = fakeContext();
	apply(ctx, {
		provider: "branch-alt",
		command: false,
		digestChars: 800
	});
	assert.equal(state.providers[0].name, "branch-alt");
	assert.equal(state.commands.length, 0);
});

test("branch_discuss wait mode returns the clamped digest", async () => {
	const { ctx, state } = fakeContext();
	let received;
	ctx.subagents.startActivation = async (spec) => {
		received = spec;
		return {
			childId: "child-1",
			result: Promise.resolve({
				output: [],
				stopReason: "completed",
				structured: {
					conclusion: "keyed by turn",
					confidence: "high",
					evidence: [{
						claim: "turn is in the key",
						source: "src/cache.ts:12"
					}],
					recommendation: "key by step prefix",
					rejected_options: [],
					open_questions: []
				}
			}),
			dispose: async () => void 0
		};
	};
	apply(ctx, {});
	const tool = state.tools[0];
	const output = await tool.execute({ question: "how is the cache keyed?" }, {
		agent: { session: {} },
		signal: undefined
	});
	assert.equal(output.status, "completed");
	assert.equal(output.child_session_id, "child-1");
	assert.equal(output.confidence, "high");
	assert.match(output.message, /child-1/);
	assert.equal(received.provider, "branch");
	assert.equal(received.delivery, "caller");
	assert.equal(received.request.outputSchema, DIGEST_SCHEMA);
	assert.match(received.request.prompt[0].text, /how is the cache keyed\?/);
});

test("branch_discuss async mode starts without waiting", async () => {
	const { ctx, state } = fakeContext();
	let delivery;
	ctx.subagents.startActivation = async (spec) => {
		delivery = spec.delivery;
		return {
			childId: "child-2",
			result: new Promise(() => void 0),
			dispose: async () => void 0
		};
	};
	apply(ctx, {});
	const output = await state.tools[0].execute({ question: "dig", mode: "async" }, { agent: { session: {} } });
	assert.equal(output.status, "started");
	assert.equal(delivery, "parent");
});

test("branch_discuss surfaces provider failures instead of throwing", async () => {
	const { ctx, state } = fakeContext();
	ctx.subagents.startActivation = async () => {
		throw new Error("child exploded");
	};
	apply(ctx, {});
	const output = await state.tools[0].execute({ question: "q" }, { agent: { session: {} } });
	assert.equal(output.status, "error");
	assert.match(output.message, /child exploded/);
});

test("branch_discuss refuses a child that ended without completing", async () => {
	const { ctx, state } = fakeContext();
	ctx.subagents.startActivation = async () => ({
		childId: "child-3",
		result: Promise.resolve({
			output: [{
				type: "text",
				text: "half a thought"
			}],
			stopReason: "max-tokens"
		}),
		dispose: async () => void 0
	});
	apply(ctx, {});
	const output = await state.tools[0].execute({ question: "q" }, { agent: { session: {} } });
	assert.equal(output.status, "error");
	assert.match(output.message, /max-tokens/);
});

test("branch_discuss falls back to text when the child skipped structured output", async () => {
	const { ctx, state } = fakeContext();
	ctx.subagents.startActivation = async () => ({
		childId: "child-4",
		result: Promise.resolve({
			output: [{
				type: "text",
				text: "it is keyed by turn"
			}],
			stopReason: "completed"
		}),
		dispose: async () => void 0
	});
	apply(ctx, {});
	const output = await state.tools[0].execute({ question: "q" }, { agent: { session: {} } });
	assert.equal(output.status, "text_only");
	assert.match(output.message, /it is keyed by turn/);
});

test("branch_discuss reports a missing provider when the subagent service has none", async () => {
	const { ctx, state } = fakeContext();
	ctx.subagents.getProvider = () => void 0;
	apply(ctx, {});
	const output = await state.tools[0].execute({ question: "q" }, { agent: { session: {} } });
	assert.equal(output.status, "error");
	assert.match(output.message, /not registered/);
});

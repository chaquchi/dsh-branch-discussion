// Offline check of the plugin's schemas against the real DSH validators.
//
// The tool definition this plugin registers is the object the runtime hands to
// the model provider, so `parameters` must already be a raw, object-rooted JSON
// Schema — the runtime does not compile a property map here. Feed the exact
// registered definition through the real validators, not a re-derived one.
import {
	assertObjectJsonSchema,
	assertSupportedJsonSchema,
	validateJsonSchemaValue
} from "../../.scratch/dsh/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js";
import { apply, DIGEST_SCHEMA } from "../index.js";

const tools = [];
const ctx = {
	subagents: { registerProvider() {}, getProvider: () => ({}) },
	tools: { register: (definition) => tools.push(definition) },
	systemPrompt: { section() {} },
	commands: { register() {} }
};
apply(ctx, {});

const tool = tools[0];
console.log("parameters.type:", tool.parameters.type);
assertObjectJsonSchema(tool.parameters);
console.log("parameters: ok (object-rooted, supported subset)");
assertObjectJsonSchema(DIGEST_SCHEMA);
console.log("DIGEST_SCHEMA: ok");
assertSupportedJsonSchema(tool.output.schema);
console.log("output.schema: ok");
console.log("valid args violations:", JSON.stringify(validateJsonSchemaValue(tool.parameters, { question: "what breaks the cache?" }, "")));
console.log("empty args violations:", JSON.stringify(validateJsonSchemaValue(tool.parameters, {}, "")));
console.log("bad mode violations:", JSON.stringify(validateJsonSchemaValue(tool.parameters, { question: "q", mode: "sync" }, "")));

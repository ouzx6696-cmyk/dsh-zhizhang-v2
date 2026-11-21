import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_REQUIRED_SERVICES,
  HOST_SERVICE_CONTRACTS,
  runInServiceScope,
} from "../src/host/dsh-adapter.ts";
import { assertHostToolDefinition, toHostToolDefinition } from "../src/host/dsh-tools-adapter.ts";
import { applyWorkbench, inject } from "../src/host/plugin.ts";
import { createZhizhangAgentTools, registerZhizhangTools } from "../src/host/tools.ts";
import {
  createMockDsHHost,
  createStrictToolRegistrar,
  withTempDir,
} from "../support/v2-harness.mjs";

const READ_ONLY_TOOLS = [
  "zhizhang_read_tree",
  "zhizhang_read_chapter",
  "zhizhang_read_known_facts",
  "zhizhang_search_workspace",
  "zhizhang_check_conflicts",
  "zhizhang_diagnose_chapter",
  "zhizhang_read_controls",
];

const PROPOSAL_TOOLS = [
  "zhizhang_propose_setting",
  "zhizhang_propose_foreshadow",
  "zhizhang_propose_technique",
];

function fakeWorkspace() {
  return {
    mutation(action, input) {
      return { action, input };
    },
    snapshot(projectId, documentId) {
      return { projectId, documentId };
    },
  };
}

async function readDiag(host) {
  const response = await host.get("/diag");
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

test("DSH-01: all 7+3 tools declare output{schema,render}, closed parameter schemas, and the strict registrar accepts them", () => {
  const specs = createZhizhangAgentTools(fakeWorkspace());
  assert.equal(specs.length, 10);
  assert.deepEqual(specs.filter((spec) => spec.readOnly).map((spec) => spec.name), READ_ONLY_TOOLS);
  assert.deepEqual(specs.filter((spec) => spec.proposalOnly).map((spec) => spec.name), PROPOSAL_TOOLS);
  assert.equal(new Set(specs.map((spec) => spec.name)).size, 10, "tool names must be unique");

  const registrar = createStrictToolRegistrar();
  for (const spec of specs) {
    const definition = toHostToolDefinition(spec);
    assert.equal(definition.parameters.type, "object");
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(typeof definition.output.schema, "object");
    assert.equal(definition.timeoutMs > 0, true);
    assert.deepEqual(definition.output.render({ projectId: "p" }, { ok: true }), [
      { type: "text", text: '{"ok":true}' },
    ]);
    registrar.register(definition);
  }
  assert.equal(registrar.tools.length, 10);
});

test("DSH-01: malformed definitions are rejected by the adapter and a failed registration rolls back the whole surface", () => {
  const [first] = createZhizhangAgentTools(fakeWorkspace());
  const valid = toHostToolDefinition(first);

  assert.throws(
    () => assertHostToolDefinition({ ...valid, output: undefined }),
    /must declare output \{ schema, render \}/,
  );
  assert.throws(
    () => assertHostToolDefinition({ ...valid, parameters: { ...valid.parameters, additionalProperties: true } }),
    /additionalProperties/,
  );
  assert.throws(() => assertHostToolDefinition({ ...valid, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(
    () => assertHostToolDefinition({ ...valid, parameters: { ...valid.parameters, required: ["missing"] } }),
    /unknown-property/,
  );

  const registrar = createStrictToolRegistrar({ failOn: "zhizhang_read_known_facts" });
  assert.throws(() => registerZhizhangTools(registrar, fakeWorkspace()), /registration rejected/);
  assert.equal(registrar.tools.length, 0, "a partial 7+3 surface must never survive");
  assert.deepEqual(registrar.disposed, ["zhizhang_read_chapter", "zhizhang_read_tree"]);
});

test("B2-5 DSH-02: the inject scope disposer is returned to the parent effect", () => {
  let disposed = false;
  const ctx = {
    inject: (_deps, callback) => {
      callback({ effect: () => () => {} });
      return () => { disposed = true; };
    },
  };
  const disposers = runInServiceScope(ctx, ["tools"], "zhizhang:test-scope", () => []);
  assert.equal(disposers.length, 1, "a Cordis scope disposer must not be dropped");
  disposers[0]();
  assert.equal(disposed, true);
});

test("DSH-02: the service contract table and the declared inject list agree on required vs optional services", () => {
  assert.deepEqual(inject, ["connection", "llm"]);
  assert.deepEqual([...HOST_REQUIRED_SERVICES], ["connection", "llm"]);
  assert.equal(HOST_SERVICE_CONTRACTS.length, 4);
  assert.deepEqual(
    HOST_SERVICE_CONTRACTS.filter((row) => row.required).map((row) => row.name),
    [...HOST_REQUIRED_SERVICES],
    "every required service must be declared in inject and listed in the contract table",
  );
  for (const row of HOST_SERVICE_CONTRACTS) {
    assert.ok(row.purpose.length > 0, `${row.name} needs a purpose`);
    assert.ok(row.source.length > 0, `${row.name} needs a contract source`);
  }
});

test("DSH-02: tools and config forms are resolved through ctx.get inside their own inject sub-scopes", async () => {
  await withTempDir("zhizhang-host-tools-cordis-", async (dataDirectory) => {
    const registrar = createStrictToolRegistrar();
    const configForms = { registered: [], register(schema) { this.registered.push(schema); return () => {}; } };
    const host = createMockDsHHost({ cordis: true, tools: registrar, configForms });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      assert.equal(host.ctx.tools, undefined, "the Cordis path must not rely on a ctx.tools property");
      assert.equal(host.ctx.configForms, undefined);
      assert.deepEqual(host.injectedScopes, [["tools"], ["configForms"]]);
      assert.ok(host.effectNames.includes("zhizhang: agent tools"));
      assert.ok(host.effectNames.includes("zhizhang: settings form"));
      assert.equal(registrar.tools.length, 10);
      assert.equal(configForms.registered.length, 1);

      const diag = await readDiag(host);
      assert.equal(diag.agentToolsEnabled, true);
      assert.equal(diag.agentToolsRegistered, true);
      assert.equal(diag.agentToolsError, null);
    } finally {
      await host.close();
    }
  });
});

test("DSH-02: a host without get/inject still receives tools through the legacy property path", async () => {
  await withTempDir("zhizhang-host-tools-legacy-", async (dataDirectory) => {
    const registrar = createStrictToolRegistrar();
    const host = createMockDsHHost({ tools: registrar });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      assert.equal(registrar.tools.length, 10);
      const diag = await readDiag(host);
      assert.equal(diag.agentToolsRegistered, true);
    } finally {
      await host.close();
    }
  });
});

test("DSH-01/23: a host that rejects a tool degrades the agent surface instead of taking down the workbench", async () => {
  await withTempDir("zhizhang-host-tools-fail-", async (dataDirectory) => {
    const registrar = createStrictToolRegistrar({ failOn: "zhizhang_propose_technique" });
    const host = createMockDsHHost({ tools: registrar });
    assert.doesNotThrow(() => applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset }));
    try {
      const page = await host.get("/workbench");
      assert.equal(page.status, 200, "workbench routes must stay available");

      const diag = await readDiag(host);
      assert.equal(diag.agentToolsEnabled, true);
      assert.equal(diag.agentToolsRegistered, false);
      assert.equal(diag.agentToolsError, "TypeError");
      assert.equal(registrar.tools.length, 0);
      assert.ok(
        host.logs.some((entry) => entry.message === "zhizhang: agent tool registration failed"),
        "the failure must be logged, not swallowed",
      );

      const state = await host.readState();
      assert.equal(state.status, 200, "the core API must keep working without agent tools");
    } finally {
      await host.close();
    }
  });
});

test("DSH-01/14: tool execute keeps the exact action mapping and honours the host abort signal", async () => {
  const workspace = fakeWorkspace();
  const registrar = createStrictToolRegistrar();
  const disposers = registerZhizhangTools(registrar, workspace);
  try {
    assert.equal(registrar.tools.length, 10);
    assert.deepEqual(await registrar.invoke("zhizhang_read_tree", { projectId: "p-1" }), {
      action: "tree.get",
      input: { projectId: "p-1" },
    });
    assert.deepEqual(await registrar.invoke("zhizhang_read_chapter", { projectId: "p-1", documentId: "c-1" }), {
      projectId: "p-1",
      documentId: "c-1",
    });

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      registrar.invoke("zhizhang_read_tree", { projectId: "p-1" }, { signal: controller.signal }),
      (error) => error.name === "AbortError",
    );
  } finally {
    for (const dispose of disposers) await dispose();
  }
  assert.equal(registrar.tools.length, 0);
  assert.equal(registrar.disposed.length, 10);
});

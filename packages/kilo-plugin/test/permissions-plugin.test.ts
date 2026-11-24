import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Flag } from "@opencode/core/flag"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Rpc } from "@opencode/core/rpc"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { KiloPermissionsRpc } from "@opencode/schema/kilocode/permissions"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { location } from "../../core/test/fixture/location"
import { testEffect } from "../../core/test/lib/effect"
import { installPermissionSets } from "../src/permissions"

const root = AbsolutePath.make(mkdtempSync(path.join(tmpdir(), "kilo-permission-sets-")))
writeFileSync(
  path.join(root, "package.json"),
  JSON.stringify({ packageManager: "bun@1.4.4", devDependencies: { typescript: "5" } }),
)
writeFileSync(path.join(root, "tsconfig.json"), "{}")

const sessionID = Session.ID.make("ses_permission_sets")
const projectID = Project.ID.make("prj_permission_sets")

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      FSUtil.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      PluginHooks.node,
      Rpc.node,
      Permission.node,
    ]),
    // Core saves grants for the Location's project, so it is the project the plugin is installed for.
    [
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            ...location({ directory: root }),
            project: { id: projectID, directory: root, canonical: root },
          }),
        ),
      ),
    ],
  ),
)

function setup(
  input: {
    rules?: Permission.Ruleset
    flags?: string
    store?: Map<string, Schema.Json>
    projectID?: Project.ID
  } = {},
) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values([
        { id: Project.ID.global, worktree: root, sandboxes: [] },
        { id: projectID, worktree: root, sandboxes: [] },
      ])
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: root,
        title: "test",
        version: "test",
        agent: Agent.ID.make("test"),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...(input.rules ?? [])]
      }),
    )
    const hooks = yield* PluginHooks.Service
    const rpc = yield* Rpc.Service
    const store = input.store ?? new Map<string, Schema.Json>()
    const ctx = {
      location: { project: { id: input.projectID ?? projectID, directory: root, canonical: root } },
      storage: {
        get: (key: string) => Effect.sync(() => store.get(key)),
        set: (key: string, value: Schema.Json) => Effect.sync(() => void store.set(key, value)),
        remove: (key: string) => Effect.sync(() => void store.delete(key)),
      },
      permission: {
        hook: (name: "evaluate", callback: Parameters<Context["permission"]["hook"]>[1]) =>
          hooks.register("permission", name, callback),
      },
      rpc: { register: rpc.register },
    }
    yield* installPermissionSets(ctx).pipe(
      Effect.provide(Flag.testLayer([], { overrides: input.flags ?? "permission_setup" })),
    )
    return {
      store,
      hooks,
      call: (method: string, body: Record<string, unknown> = {}) => rpc.call("kilocode.permissions", method, body),
    }
  })
}
function setAgentRules(id: Agent.ID, rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(id, (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function shell(resources: string[], input: Partial<Permission.AssertInput> = {}): Permission.AssertInput {
  return { sessionID, action: "shell", resources, ...input }
}

// Starts a shell request as the shell tool makes it and waits until it is pending.
function waiting(resources: string[], save: string[], input: Partial<Permission.AssertInput> = {}) {
  return Effect.gen(function* () {
    const permission = yield* Permission.Service
    const bus = yield* Bus.Service
    const id = Permission.ID.create()
    const asked = yield* Deferred.make<void>()
    const unsubscribe = yield* bus.listen((event) =>
      event.type === Permission.Event.Asked.type && (event.data as Permission.Request).id === id
        ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* permission.assert(shell(resources, { id, save, ...input })).pipe(Effect.forkScoped)
    yield* Deferred.await(asked)
    return { id, fiber }
  })
}

describe("KiloPermissionsPlugin", () => {
  it.effect("allows covered shell asks once a set is applied and leaves everything else asking", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const permission = yield* Permission.Service
      expect(yield* permission.ask(shell(["bun run test"]))).toMatchObject({ effect: "ask" })
      yield* call("apply", { presetID: "typescript-checks" })
      expect(yield* permission.ask(shell(["bun run test"]))).toMatchObject({ effect: "allow" })
      expect(yield* permission.ask(shell(["bun run test", "git push"]))).toMatchObject({ effect: "ask" })
      expect(yield* permission.ask(shell(["echo x > .git/hooks/pre-commit"]))).toMatchObject({ effect: "ask" })
      expect(yield* permission.ask(shell(["bun install"]))).toMatchObject({ effect: "ask" })
      expect(yield* permission.ask(shell(["src/index.ts"], { action: "read" }))).toMatchObject({ effect: "ask" })
      expect(yield* call("list")).toMatchObject({
        decision: "accepted",
        applied: [{ id: "typescript-checks", resources: expect.arrayContaining(["bun run test *"]) }],
      })
    }),
  )

  it.effect("removes one applied set and keeps the others and the decision", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const permission = yield* Permission.Service
      yield* call("apply", { presetID: "typescript-checks" })
      yield* call("apply", { presetID: "dependency-install" })
      yield* call("remove", { presetID: "typescript-checks" })
      expect(yield* call("list")).toMatchObject({ decision: "accepted", applied: [{ id: "dependency-install" }] })
      expect(yield* permission.ask(shell(["bun run test"]))).toMatchObject({ effect: "ask" })
      expect(yield* permission.ask(shell(["bun install"]))).toMatchObject({ effect: "allow" })
      yield* call("remove", { presetID: "typescript-checks" })
      expect(yield* call("list")).toMatchObject({ applied: [{ id: "dependency-install" }] })
    }),
  )

  it.effect("drops stored sets that no longer exist", () =>
    Effect.gen(function* () {
      const store = new Map<string, Schema.Json>([
        [
          `applied:${projectID}`,
          [
            { id: "typescript-install", resources: ["bun install *"] },
            { id: "typescript-checks", resources: ["bun run test *"] },
          ],
        ],
      ])
      const { call } = yield* setup({ store })
      const permission = yield* Permission.Service
      expect(yield* call("list")).toMatchObject({ applied: [{ id: "typescript-checks" }] })
      expect(yield* permission.ask(shell(["bun install"]))).toMatchObject({ effect: "ask" })
      expect(yield* permission.ask(shell(["bun run test"]))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("keeps configured denies", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ rules: [{ action: "shell", resource: "*", effect: "deny" }] })
      yield* call("apply", { presetID: "typescript-checks" })
      const permission = yield* Permission.Service
      const blocked = yield* permission.assert(shell(["bun run test"])).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
    }),
  )

  it.effect("leaves human-only requests and later hardening hooks in charge", () =>
    Effect.gen(function* () {
      const { call, hooks } = yield* setup()
      yield* call("apply", { presetID: "typescript-checks" })
      const permission = yield* Permission.Service
      expect(yield* permission.ask(shell(["bun run test"], { metadata: { interactive: true } }))).toMatchObject({
        effect: "ask",
      })
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.sync(() => {
          if (event.resources.includes("bun run lint")) event.effect = "ask"
        }),
      )
      expect(yield* permission.ask(shell(["bun run lint"]))).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("settles unattended runs like a saved approval: covered commands allow, others deny", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      yield* call("apply", { presetID: "typescript-checks" })
      const permission = yield* Permission.Service
      const unattended = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(Permission.Unattended, []))
      expect(yield* unattended(permission.ask(shell(["bun run test"])))).toMatchObject({ effect: "allow" })
      expect(yield* unattended(permission.ask(shell(["git push"])))).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("settles waiting requests the applied set covers and keeps the others pending", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const permission = yield* Permission.Service
      const bus = yield* Bus.Service
      const coveredID = Permission.ID.create("per_covered")
      const uncoveredID = Permission.ID.create("per_uncovered")
      const asked = yield* Deferred.make<void>()
      const seen = new Set<string>()
      const unsubscribe = yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        seen.add((event.data as Permission.Request).id)
        return seen.size === 2 ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid) : Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      const covered = yield* permission.assert(shell(["bun run test"], { id: coveredID })).pipe(Effect.forkScoped)
      const uncovered = yield* permission.assert(shell(["bun install"], { id: uncoveredID })).pipe(Effect.forkScoped)
      yield* Deferred.await(asked)

      yield* call("apply", { presetID: "typescript-checks" })
      yield* Fiber.join(covered)
      expect((yield* permission.list()).map((request) => request.id)).toEqual([uncoveredID])

      yield* call("apply", { presetID: "dependency-install" })
      yield* Fiber.join(uncovered)
      expect(yield* permission.list()).toEqual([])
    }),
  )

  it.effect("leaves a waiting request pending when the sets cover only part of it", () =>
    Effect.gen(function* () {
      // The agent's own rule allows `git push`; a pending request does not say which agent asked, so applying a set
      // never settles a request on the strength of rules other than the set's own.
      const { call } = yield* setup({ rules: [{ action: "shell", resource: "git push", effect: "allow" }] })
      const permission = yield* Permission.Service
      const bus = yield* Bus.Service
      const requestID = Permission.ID.create("per_partial")
      const asked = yield* Deferred.make<void>()
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Permission.Event.Asked.type
          ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* permission.assert(shell(["bun run test", "git push"], { id: requestID })).pipe(Effect.forkScoped)
      yield* Deferred.await(asked)

      yield* call("apply", { presetID: "typescript-checks" })
      expect((yield* permission.list()).map((request) => request.id)).toEqual([requestID])
      // A new request with the same parts is decided by the live evaluation, which sees the asking agent's rules.
      expect(yield* permission.ask(shell(["bun run test", "git push"]))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("offers and applies nothing for the shared global project", () =>
    Effect.gen(function* () {
      const store = new Map<string, Schema.Json>([
        [`applied:${Project.ID.global}`, [{ id: "typescript-checks", resources: ["bun run test *"] }]],
      ])
      const { call } = yield* setup({ projectID: Project.ID.global, store })
      const permission = yield* Permission.Service
      expect(yield* call("list")).toMatchObject({ unidentified: true, presets: [], applied: [] })
      expect(yield* permission.ask(shell(["bun run test"]))).toMatchObject({ effect: "ask" })
      const failed = yield* call("apply", { presetID: "typescript-checks" }).pipe(Effect.flip)
      expect(failed).toMatchObject({ type: "not_applicable" })
      yield* call("skip")
      expect(store.has(`offer:${Project.ID.global}`)).toBe(false)
    }),
  )

  it.effect(
    "resets the decision, and with all the applied sets, publishes each reset without touching saved grants",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { call } = yield* setup()
          const rpc = yield* Rpc.Service
          const saved = yield* PermissionSaved.Service
          const permission = yield* Permission.Service
          const updates = yield* rpc
            .client(KiloPermissionsRpc.Definition)
            .events.subscribe("updated")
            .pipe(
              Stream.map((event) => event.data),
              Stream.take(3),
              Stream.runCollect,
              Effect.forkScoped({ startImmediately: true }),
            )
          yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: ["make deploy"] })
          const before = yield* saved.list()
          yield* call("apply", { presetID: "typescript-checks" })

          expect(yield* call("reset", {})).toEqual({ removed: 0 })
          expect(yield* call("list")).toMatchObject({ decision: null, applied: [{ id: "typescript-checks" }] })

          const reset = (yield* call("reset", { all: true })) as { removed: number }
          expect(reset.removed).toBeGreaterThan(0)
          expect(yield* call("list")).toMatchObject({ decision: null, applied: [] })
          expect(yield* saved.list()).toEqual(before)
          expect(yield* permission.ask(shell(["bun run test"]))).toMatchObject({ effect: "ask" })
          // Clients remember a decided project, so a reset that keeps the sets still publishes.
          expect(yield* Fiber.join(updates)).toMatchObject([
            { projectID, applied: [{ id: "typescript-checks" }] },
            { projectID, applied: [{ id: "typescript-checks" }] },
            { projectID, applied: [] },
          ])
        }),
      ),
  )

  it.effect("clears the applied sets, records the offer as skipped and publishes the change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup()
        const rpc = yield* Rpc.Service
        const permission = yield* Permission.Service
        const updates = yield* rpc
          .client(KiloPermissionsRpc.Definition)
          .events.subscribe("updated")
          .pipe(
            Stream.map((event) => event.data),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )
        yield* call("apply", { presetID: "typescript-checks" })
        yield* call("skip")
        expect(yield* call("list")).toMatchObject({ decision: "skipped", applied: [{ id: "typescript-checks" }] })

        yield* call("clear")
        expect(yield* call("list")).toMatchObject({ decision: "skipped", applied: [] })
        expect(yield* permission.ask(shell(["bun run test"]))).toMatchObject({ effect: "ask" })
        expect(yield* Fiber.join(updates)).toMatchObject([
          { projectID, applied: [{ id: "typescript-checks" }] },
          { projectID, applied: [] },
        ])
      }),
    ),
  )

  it.effect("reports which commands of a request need approval and saves only the chosen rule for them", () =>
    Effect.gen(function* () {
      // `foo this` is allowed exactly; saving the tool's `foo *` would widen that grant.
      const { call } = yield* setup({ rules: [{ action: "shell", resource: "foo this", effect: "allow" }] })
      const saved = yield* PermissionSaved.Service
      const permission = yield* Permission.Service
      const request = yield* waiting(["foo this", "bar that"], ["foo *", "bar *"])

      const inspected = yield* call("inspect", { requestID: request.id })
      expect(inspected).toMatchObject({
        parts: [
          { resource: "foo this", rule: "foo *", allowed: true },
          { resource: "bar that", rule: "bar *", allowed: false },
        ],
      })
      if (process.platform === "win32") {
        const parts = (inspected as { readonly parts: ReadonlyArray<Record<string, unknown>> }).parts
        expect(parts[0]).not.toHaveProperty("exact")
        expect(parts[1]).not.toHaveProperty("exact")
      } else {
        expect(inspected).toMatchObject({
          parts: [
            { exact: "foo this" },
            { exact: "bar that" },
          ],
        })
      }

      const selected = process.platform === "win32" ? "bar *" : "bar that"
      yield* call("approve", { requestID: request.id, rules: [selected] })
      yield* Fiber.join(request.fiber)
      expect(yield* permission.list()).toEqual([])
      expect((yield* saved.list()).map((item) => [item.action, item.resource])).toEqual([["shell", selected]])
      expect(yield* permission.ask(shell(["bar that"]))).toMatchObject({ effect: "allow" })
      expect(yield* permission.ask(shell(["bar other"]))).toMatchObject({
        effect: process.platform === "win32" ? "allow" : "ask",
      })
    }),
  )
  it.effect("saves a narrowed grant using the pending request agent", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ rules: [{ action: "shell", resource: "bun run test", effect: "allow" }] })
      const saved = yield* PermissionSaved.Service
      const permission = yield* Permission.Service
      const requester = Agent.ID.make("requester")
      yield* setAgentRules(requester, [])
      const request = yield* waiting(["bun run test"], ["bun run *"], { agent: requester })

      const inspected = yield* call("inspect", { requestID: request.id })
      expect(inspected).toMatchObject({
        parts: [{ resource: "bun run test", rule: "bun run *", allowed: false }],
      })
      if (process.platform === "win32") {
        const parts =
          inspected && typeof inspected === "object" && "parts" in inspected && Array.isArray(inspected.parts)
            ? inspected.parts
            : []
        expect(parts).toHaveLength(1)
        expect(parts[0]).not.toHaveProperty("exact")
      }
      const selected = process.platform === "win32" ? "bun run *" : "bun run test"
      yield* call("approve", { requestID: request.id, rules: [selected] })
      yield* Fiber.join(request.fiber)

      expect((yield* saved.list()).map((item) => item.resource)).toEqual([selected])
      expect(yield* permission.ask(shell(["bun run test"], { agent: requester }))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("inspects a pending request with its agent instead of the current session agent", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const requester = Agent.ID.make("requester")
      yield* setAgentRules(requester, [])
      const request = yield* waiting(["bun run test"], ["bun run *"], { agent: requester })
      yield* setAgentRules(requester, [{ action: "shell", resource: "bun run test", effect: "allow" }])

      expect(yield* call("inspect", { requestID: request.id })).toMatchObject({
        parts: [{ resource: "bun run test", rule: "bun run *", allowed: true }],
      })
      yield* call("approve", { requestID: request.id, rules: [] })
      yield* Fiber.join(request.fiber)
    }),
  )

  it.effect("does not offer exact grants when separator normalization collides", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const saved = yield* PermissionSaved.Service
      const permission = yield* Permission.Service
      const resources = ["bun run src/index.ts", "bun run src\\index.ts"]
      const request = yield* waiting(resources, ["bun run *", "bun run *"])

      const inspected = yield* call("inspect", { requestID: request.id })
      expect(inspected).toMatchObject({
        parts: [
          { resource: resources[0], rule: "bun run *", allowed: false },
          { resource: resources[1], rule: "bun run *", allowed: false },
        ],
      })
      const parts =
        inspected && typeof inspected === "object" && "parts" in inspected && Array.isArray(inspected.parts)
          ? inspected.parts
          : []
      expect(parts).toHaveLength(2)
      for (const part of parts) expect(part).not.toHaveProperty("exact")

      for (const resource of resources) {
        const failed = yield* call("approve", { requestID: request.id, rules: [resource] }).pipe(Effect.flip)
        expect(failed).toMatchObject({ type: "not_applicable" })
      }
      expect(yield* saved.list()).toEqual([])
      for (const resource of resources)
        expect(yield* permission.ask(shell([resource]))).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("treats commands a permission set covers as allowed and never saves rules for them", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      yield* call("apply", { presetID: "typescript-checks" })
      const saved = yield* PermissionSaved.Service
      const request = yield* waiting(["bun run test", "git push origin"], ["bun run test *", "git push *"])

      expect(yield* call("inspect", { requestID: request.id })).toMatchObject({
        parts: [
          { resource: "bun run test", allowed: true },
          { resource: "git push origin", rule: "git push *", allowed: false },
        ],
      })
      yield* call("approve", { requestID: request.id, rules: ["git push *"] })
      yield* Fiber.join(request.fiber)
      expect((yield* saved.list()).map((item) => item.resource)).toEqual(["git push *"])
    }),
  )

  it.effect("refuses rules that were not offered for a command needing approval and changes nothing", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ rules: [{ action: "shell", resource: "foo this", effect: "allow" }] })
      const saved = yield* PermissionSaved.Service
      const permission = yield* Permission.Service
      const request = yield* waiting(["foo this", "bar that"], ["foo *", "bar *"])
      for (const rules of [["foo *"], ["bar that", "rm *"]]) {
        const failed = yield* call("approve", { requestID: request.id, rules }).pipe(Effect.flip)
        expect(failed).toMatchObject({ type: "not_applicable" })
      }
      expect((yield* permission.list()).map((item) => item.id)).toEqual([request.id])
      expect(yield* saved.list()).toEqual([])
    }),
  )

  it.effect("saves without raising another prompt and settles only the waiting requests the rules cover", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const saved = yield* PermissionSaved.Service
      const permission = yield* Permission.Service
      const bus = yield* Bus.Service
      const request = yield* waiting(["foo this", "bar that"], ["foo *", "bar *"])
      const covered = yield* waiting(["bar other"], ["bar *"])
      const uncovered = yield* waiting(["baz this"], ["baz *"])
      // Listeners run inside publish, so every prompt `approve` raised would be recorded by the time it returns.
      const asked: unknown[] = []
      const unsubscribe = yield* bus.listen((event) =>
        Effect.sync(() => {
          if (event.type === Permission.Event.Asked.type) asked.push(event.data)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* call("approve", { requestID: request.id, rules: ["foo *", "bar *"] })
      yield* Fiber.join(request.fiber)
      yield* Fiber.join(covered.fiber)
      expect(asked).toEqual([])
      expect((yield* permission.list()).map((item) => item.id)).toEqual([uncovered.id])
      expect((yield* saved.list()).map((item) => item.resource).sort()).toEqual(["bar *", "foo *"])
    }),
  )

  it.effect("approves once without saving when no rule is chosen, and offers no exact rule for a wildcard", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const saved = yield* PermissionSaved.Service
      const request = yield* waiting(["rm *.log"], ["rm *"])
      expect(yield* call("inspect", { requestID: request.id })).toEqual({
        parts: [{ resource: "rm *.log", rule: "rm *", allowed: false }],
      })
      yield* call("approve", { requestID: request.id, rules: [] })
      yield* Fiber.join(request.fiber)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  it.effect("does not narrow requests for a person or a non-shell action", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const interactive = yield* waiting(["git push"], ["git push *"], { metadata: { interactive: true } })
      const read = yield* waiting(["src/index.ts"], ["*"], { action: "read" })
      for (const id of [interactive.id, read.id, Permission.ID.create()]) {
        const failed = yield* call("inspect", { requestID: id }).pipe(Effect.flip)
        expect(failed).toMatchObject({ type: "not_applicable" })
      }
    }),
  )

  it.effect("ignores applied sets and refuses changes while the flag is off", () =>
    Effect.gen(function* () {
      const store = new Map<string, Schema.Json>([
        [`applied:${projectID}`, [{ id: "typescript-checks", resources: ["bun run test *"] }]],
      ])
      const { call } = yield* setup({ flags: "-permission_setup", store })
      const permission = yield* Permission.Service
      expect(yield* permission.ask(shell(["bun run test"]))).toMatchObject({ effect: "ask" })
      expect(yield* call("list")).toMatchObject({ enabled: false, presets: [] })
      const failed = yield* call("apply", { presetID: "typescript-checks" }).pipe(Effect.flip)
      expect(failed).toMatchObject({ type: "unavailable" })
      expect(yield* call("reset", { all: true }).pipe(Effect.flip)).toMatchObject({ type: "unavailable" })
      expect(store.has(`applied:${projectID}`)).toBe(true)
      const request = yield* waiting(["bun run test"], ["bun run test *"])
      for (const [method, body] of [
        ["inspect", { requestID: request.id }],
        ["approve", { requestID: request.id, rules: [] }],
      ] as const) {
        const refused = yield* call(method, body).pipe(Effect.flip)
        expect(refused).toMatchObject({ type: "unavailable" })
      }
    }),
  )
})

// Narrowed shell approvals. A shell request carries every command of the call, and "Always allow" saves a rule for
// each one, including commands the rules or permission sets already allow; that can widen an exact grant into a
// prefix wildcard. `inspect` reports which commands still need approval, and `approve` saves only the rules the user
// chose for those. It writes them as project grants itself rather than through a second permission request, which
// every client would see as a new prompt, then answers the request and the other waiting requests the rules cover.
import { Permission } from "@opencode/core/permission"
import type { PermissionSaved } from "@opencode/core/permission/saved"
import { KiloPermission } from "@opencode/schema/kilocode/permission"
import type { KiloPermissionsRpc } from "@opencode/schema/kilocode/permissions"
import type { Project } from "@opencode/schema/project"
import { Effect } from "effect"

type Narrowable = Permission.Request & {
  readonly save: readonly string[]
  readonly agent?: Permission.AssertInput["agent"]
}

/** The commands of a pending shell request and whether each is already allowed; undefined when it cannot narrow. */
export const inspect = Effect.fn("KiloPermissions.inspect")(function* (
  permission: Permission.Interface,
  requestID: Permission.ID,
) {
  const request = yield* permission.get(requestID, { includeAgent: true })
  if (!narrowable(request)) return undefined
  return yield* parts(permission, request)
})

/**
 * Saves `rules` for the commands that need approval and allows the request. `missing` when the request cannot
 * narrow (gone, not shell, or for a person only); `invalid` when a rule is not one offered for a needed command.
 */
export const approve = Effect.fn("KiloPermissions.approve")(function* (
  services: {
    readonly permission: Permission.Interface
    readonly saved: PermissionSaved.Interface
    readonly projectID: Project.ID
  },
  requestID: Permission.ID,
  rules: readonly string[],
) {
  const request = yield* services.permission.get(requestID, { includeAgent: true })
  if (!narrowable(request)) return "missing" as const
  const needed = (yield* parts(services.permission, request)).filter((part) => !part.allowed)
  const offered = new Set(needed.flatMap((part) => (part.exact ? [part.rule, part.exact] : [part.rule])))
  if (rules.some((rule) => !offered.has(rule))) return "invalid" as const
  yield* services.saved.add({ projectID: services.projectID, action: request.action, resources: [...new Set(rules)] })
  // An empty or partial rule selection still approves this call once.
  yield* replyOnce(services.permission, requestID)
  if (rules.length > 0) yield* settle(services.permission, request.action)
  return "approved" as const
})

// Answers the other waiting requests the new rules now allow, as core does after an "always" reply. Each is evaluated
// with the agent that asked, and answered once so its own rules are not saved too.
function settle(permission: Permission.Interface, action: string) {
  return Effect.gen(function* () {
    for (const pending of yield* permission.list()) {
      if (pending.action !== action || KiloPermission.requiresPerson(pending.metadata)) continue
      const request = yield* permission.get(pending.id, { includeAgent: true })
      if (request === undefined) continue
      const allowed = yield* permission
        .allows({ ...request })
        .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)))
      if (allowed) yield* replyOnce(permission, request.id)
    }
  })
}

function replyOnce(permission: Permission.Interface, requestID: Permission.ID) {
  return permission
    .reply({ requestID, reply: "once" })
    .pipe(Effect.catchTag("Permission.NotFoundError", () => Effect.void))
}

function narrowable(request: Permission.Request | undefined): request is Narrowable {
  return (
    request !== undefined &&
    request.action === "shell" &&
    !KiloPermission.requiresPerson(request.metadata) &&
    request.resources.length > 0 &&
    // The shell tool builds both lists from the same parsed commands, so each rule belongs to the same position.
    request.save?.length === request.resources.length
  )
}

// Permission.get omits the requester by default; narrowed checks must opt in so they do not use the session's agent.
function parts(permission: Permission.Interface, request: Narrowable) {
  return Effect.forEach(
    request.resources,
    (resource, index): Effect.Effect<KiloPermissionsRpc.RequestPart> =>
      permission
        .allows({
          sessionID: request.sessionID,
          agent: request.agent,
          action: request.action,
          resources: [resource],
          metadata: request.metadata,
          source: request.source,
        })
        .pipe(
          Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
          Effect.map((allowed) => ({
            resource,
            rule: request.save[index],
            exact: exactRule(resource, request.save[index]),
            allowed,
          })),
        ),
  )
}

// Saved rules are wildcard patterns. Separator normalization and Windows case-insensitivity can make an apparently
// exact rule match a distinct shell command, so those resources never receive an exact offer.
function exactRule(resource: string, rule: string) {
  if (resource === rule || /[*?]/.test(resource)) return undefined
  if (process.platform === "win32" || /[\\/]/.test(resource)) return undefined
  return resource
}

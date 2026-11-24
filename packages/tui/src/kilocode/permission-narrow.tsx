import { dict } from "@kilocode/kilo-i18n/en"
import type { LocationRef, PermissionReply, PermissionRequest } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { KiloPermissionsRpc } from "@opencode/schema/kilocode/permissions"
import type { RequestPart } from "@opencode/schema/kilocode/permissions"
import { CliRenderEvents, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { useCursorStyle } from "../config"
import { useData } from "../context/data"
import { useInteractivity } from "../context/interactivity"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { PermissionPrompt, SessionQuestion } from "../routes/session/permission"
import { permissionOptionLabel } from "../util/permission"

// Narrowed shell approvals: the permissions plugin reports which commands of a shell request still need approval.
// The prompt highlights those in the full command, and "Always allow" saves rules only for them. Any request the
// plugin cannot narrow, or any failure, shows the normal prompt.

type CopyKey = Extract<keyof typeof dict, `tui.permissions.${string}`>

type Inspection = { readonly status: "loading" } | { readonly status: "fallback" } | Narrowed

type Narrowed = { readonly status: "narrowed"; readonly location: LocationRef; readonly parts: readonly RequestPart[] }

type Segment = { readonly text: string; readonly part?: RequestPart }

function t(key: CopyKey) {
  return dict[key]
}

export async function resolveSessionLocation(
  context: Plugin.Context,
  sessionID: string,
): Promise<LocationRef | undefined> {
  const current = context.data.session.get(sessionID)
  if (current) return current.location
  await context.data.session.sync(sessionID).catch(() => undefined)
  return context.data.session.get(sessionID)?.location
}

export function PermissionStatus(props: { readonly message: string }) {
  const theme = useTheme()
  return (
    <box id="session.permission.status" paddingLeft={2} paddingTop={1} paddingBottom={1}>
      <text fg={theme.text.muted}>{props.message}</text>
    </box>
  )
}

/**
 * The permission prompt for one request: narrowed for a shell request the plugin can split, otherwise the normal one.
 * `enabled` is false when the server already reported permission setup off; then nothing is asked of the plugin.
 */
export function NarrowedPermission(props: {
  readonly context: Plugin.Context
  readonly request: PermissionRequest
  readonly directory: string | undefined
  readonly enabled: boolean | undefined
}) {
  const skip = () => props.request.action !== "shell" || props.enabled === false
  const [inspection, setInspection] = createSignal<Inspection>({ status: skip() ? "fallback" : "loading" })
  createEffect(
    on(
      () => props.request.id,
      (requestID) => {
        if (skip()) return setInspection({ status: "fallback" })
        setInspection({ status: "loading" })
        void inspect(props.context, props.request).then((result) => {
          if (props.request.id === requestID) setInspection(result)
        })
      },
    ),
  )
  return (
    <Switch>
      <Match when={inspection().status === "loading"}>
        <PermissionStatus message={t("tui.permissions.narrow.checking")} />
      </Match>
      <Match when={inspection().status === "narrowed" && (inspection() as Narrowed)}>
        {(narrowed) => (
          <NarrowedPrompt
            context={props.context}
            request={props.request}
            narrowed={narrowed()}
            fallback={() => setInspection({ status: "fallback" })}
          />
        )}
      </Match>
      <Match when={true}>
        <PermissionPrompt request={props.request} directory={props.directory} />
      </Match>
    </Switch>
  )
}

async function inspect(context: Plugin.Context, request: PermissionRequest): Promise<Inspection> {
  const location = await resolveSessionLocation(context, request.sessionID)
  if (!location) return { status: "fallback" }
  // A server without the plugin, a request it cannot narrow, or one with nothing to narrow shows the normal prompt.
  const parts = await context.client
    .rpc(KiloPermissionsRpc.Definition)
    .inspect({ requestID: request.id }, { location })
    .then((result) => result.parts)
    .catch(() => [])
  if (!parts.some((part) => !part.allowed)) return { status: "fallback" }
  return { status: "narrowed", location, parts }
}

function NarrowedPrompt(props: {
  readonly context: Plugin.Context
  readonly request: PermissionRequest
  readonly narrowed: Narrowed
  readonly fallback: () => void
}) {
  const data = useData()
  const [stage, setStage] = createSignal<"permission" | "rules" | "reject" | "saving">("permission")
  const session = createMemo(() => data.session.get(props.request.sessionID))
  const needed = createMemo(() => props.narrowed.parts.filter((part) => !part.allowed))
  // Each needed command starts as the tool's own rule; the user can switch individual commands to exact grants.
  const [exact, setExact] = createSignal<ReadonlySet<number>>(new Set())
  const chosen = () => [
    ...new Set(needed().map((part, index) => (part.exact && exact().has(index) ? part.exact : part.rule))),
  ]

  const reply = (decision: PermissionReply, message?: string) => {
    void data.session.permission
      .reply({ sessionID: props.request.sessionID, requestID: props.request.id, decision, message })
      .catch((error: unknown) => props.context.ui.toast.show({ variant: "error", message: String(error) }))
  }

  const save = async () => {
    setStage("saving")
    const approved = await props.context.client
      .rpc(KiloPermissionsRpc.Definition)
      .approve({ requestID: props.request.id, rules: chosen() }, { location: props.narrowed.location })
      .then(() => true)
      .catch(() => false)
    if (!approved) {
      props.context.ui.toast.show({ variant: "error", message: t("tui.permissions.narrow.saveFailed") })
      props.fallback()
      return
    }
    await data.session.permission.sync(props.request.sessionID).catch(() => undefined)
  }

  return (
    <Switch>
      <Match when={stage() === "saving"}>
        <PermissionStatus message={t("tui.permissions.narrow.saving")} />
      </Match>
      <Match when={stage() === "reject"}>
        <RejectFeedback
          instance={props.request.id}
          onConfirm={(message) => reply("reject", message || undefined)}
          onCancel={() => setStage("permission")}
        />
      </Match>
      <Match when={stage() === "rules"}>
        <RuleChooser
          instance={props.request.id}
          needed={needed()}
          allowed={props.narrowed.parts.filter((part) => part.allowed)}
          exact={exact()}
          toggle={(index) =>
            setExact((current) => {
              const next = new Set(current)
              if (next.has(index)) next.delete(index)
              else next.add(index)
              return next
            })
          }
          onSave={() => void save()}
          onBack={() => setStage("permission")}
        />
      </Match>
      <Match when={stage() === "permission"}>
        <SessionQuestion
          id="session.permission.narrowed"
          title={t("tui.permissions.narrow.title")}
          instance={props.request.id}
          options={{
            once: permissionOptionLabel("once"),
            always: permissionOptionLabel("always"),
            reject: permissionOptionLabel("reject"),
          }}
          escapeKey="reject"
          fullscreen
          body={(option) => (
            <RequestBody
              context={props.context}
              request={props.request}
              parts={props.narrowed.parts}
              rules={option === "always" ? chosen() : undefined}
            />
          )}
          onSelect={(option) => {
            if (option === "always") return setStage("rules")
            if (option === "once") return reply("once")
            if (session()?.parentID) return setStage("reject")
            reply("reject")
          }}
        />
      </Match>
    </Switch>
  )
}

/** The full command with the commands that need approval highlighted; a list when the command text is not at hand. */
function RequestBody(props: {
  readonly context: Plugin.Context
  readonly request: PermissionRequest
  readonly parts: readonly RequestPart[]
  readonly rules: readonly string[] | undefined
}) {
  const theme = useTheme()
  const segments = createMemo(() => {
    const command = toolCommand(props.context, props.request)
    return command === undefined ? undefined : locate(command, props.parts)
  })
  return (
    <box paddingLeft={1} gap={1}>
      <text fg={theme.text.muted}>{t("tui.permissions.narrow.legend")}</text>
      <Show
        when={segments()}
        fallback={
          <box>
            <For each={props.parts}>
              {(part) => (
                <text fg={part.allowed ? theme.text.muted : theme.text.base}>
                  <span style={{ fg: part.allowed ? theme.text.muted : theme.text.feedback.warning.base }}>
                    {part.allowed ? "✓ " : "△ "}
                  </span>
                  {part.resource}
                </text>
              )}
            </For>
          </box>
        }
      >
        {(list) => (
          <text fg={theme.text.muted}>
            {"$ "}
            <For each={list()}>
              {(segment) =>
                segment.part && !segment.part.allowed ? (
                  <span style={{ fg: theme.text.feedback.warning.base, underline: true }}>{segment.text}</span>
                ) : (
                  <span style={{ fg: theme.text.muted }}>{segment.text}</span>
                )
              }
            </For>
          </text>
        )}
      </Show>
      <Show when={props.rules}>
        {(rules) => (
          <box>
            <text fg={theme.text.muted}>{t("tui.permissions.narrow.alwaysPreview")}</text>
            <For each={rules()}>{(rule) => <text fg={theme.text.base}>{`- ${rule}`}</text>}</For>
          </box>
        )}
      </Show>
    </box>
  )
}

/** The rules "Always allow" saves: one per needed command, each the tool's rule or the exact command. */
function RuleChooser(props: {
  readonly instance: string
  readonly needed: readonly RequestPart[]
  readonly allowed: readonly RequestPart[]
  readonly exact: ReadonlySet<number>
  readonly toggle: (index: number) => void
  readonly onSave: () => void
  readonly onBack: () => void
}) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const narrow = createMemo(() => dimensions().width < 80)
  const [cursor, setCursor] = createSignal(0)
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  const [viewportVersion, setViewportVersion] = createSignal(0)
  const move = (delta: number) => setCursor((index) => Math.max(0, Math.min(props.needed.length - 1, index + delta)))
  const toggleCursor = () => {
    const part = props.needed[cursor()]
    if (part?.exact) props.toggle(cursor())
  }
  const resize = () => setViewportVersion((version) => version + 1)
  renderer.on(CliRenderEvents.RESIZE, resize)
  onCleanup(() => renderer.off(CliRenderEvents.RESIZE, resize))
  createEffect(() => {
    const current = scroll()
    const index = cursor()
    dimensions()
    viewportVersion()
    if (!current) return
    const reveal = () => {
      if (current.isDestroyed) return
      const row = current.getChildren()[index]
      if (row) current.scrollChildIntoView(row.id)
    }
    renderer.once(CliRenderEvents.FRAME, reveal)
    renderer.requestRender()
    onCleanup(() => renderer.off(CliRenderEvents.FRAME, reveal))
  })
  Keymap.createLayer(() => ({
    mode: "base",
    priority: 2,
    commands: [
      { bind: "up,k", title: t("tui.permissions.narrow.previous"), run: () => move(-1) },
      { bind: "down,j", title: t("tui.permissions.narrow.next"), run: () => move(1) },
      { bind: "pageup", title: t("tui.permissions.narrow.previous"), run: () => move(-5) },
      { bind: "pagedown", title: t("tui.permissions.narrow.next"), run: () => move(5) },
      { bind: "home", title: t("tui.permissions.narrow.first"), run: () => setCursor(0) },
      { bind: "end", title: t("tui.permissions.narrow.last"), run: () => setCursor(props.needed.length - 1) },
      { bind: "space", title: t("tui.permissions.narrow.switch"), run: toggleCursor },
    ],
  }))
  return (
    <SessionQuestion
      id="session.permission.narrowed.rules"
      title={t("tui.permissions.narrow.rulesTitle")}
      instance={props.instance}
      options={{ save: t("tui.permissions.narrow.save"), back: t("tui.permissions.narrow.back") }}
      escapeKey="back"
      fullscreen
      onSelect={(option) => (option === "save" ? props.onSave() : props.onBack())}
      body={
        <box paddingLeft={1} gap={1} flexGrow={1} flexShrink={1} minHeight={0}>
          <text fg={theme.text.muted} flexShrink={0}>
            {t("tui.permissions.narrow.rulesHint")}
          </text>
          <scrollbox
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            contentOptions={{ minHeight: 0 }}
            ref={(value: ScrollBoxRenderable) => {
              setScroll(value)
            }}
            verticalScrollbarOptions={{ visible: true }}
          >
            <For each={props.needed}>
              {(part, index) => (
                <box
                  flexDirection={narrow() ? "column" : "row"}
                  gap={narrow() ? 0 : 2}
                  onMouseUp={() => {
                    setCursor(index())
                    toggleCursor()
                  }}
                >
                  <RuleOption
                    active={index() === cursor()}
                    selected={!props.exact.has(index())}
                    label={part.rule}
                    marker
                  />
                  <Show when={part.exact}>
                    {(value) => (
                      <box paddingLeft={narrow() ? 2 : 0}>
                        <RuleOption
                          active={index() === cursor()}
                          selected={props.exact.has(index())}
                          label={value()}
                        />
                      </box>
                    )}
                  </Show>
                </box>
              )}
            </For>
            <Show when={props.allowed.length > 0}>
              <box flexShrink={0}>
                <text fg={theme.text.muted}>{t("tui.permissions.narrow.alreadyAllowed")}</text>
                <For each={props.allowed}>{(part) => <text fg={theme.text.muted}>{`  ${part.resource}`}</text>}</For>
              </box>
            </Show>
          </scrollbox>
        </box>
      }
    />
  )
}

function RuleOption(props: {
  readonly active: boolean
  readonly selected: boolean
  readonly label: string
  readonly marker?: boolean
}) {
  const theme = useTheme()
  const cursor = () => (props.marker ? (props.active ? "› " : "  ") : "")
  return (
    <text fg={props.active ? theme.text.formfield.focused : theme.text.formfield.base}>
      <span style={{ fg: props.selected ? theme.text.formfield.selected : theme.text.muted }}>
        {`${cursor()}(${props.selected ? "•" : " "}) `}
      </span>
      {props.label}
    </text>
  )
}

/** Feedback for a declined request from a subagent, so the parent agent can continue differently. */
function RejectFeedback(props: {
  readonly instance: string
  readonly onConfirm: (message: string) => void
  readonly onCancel: () => void
}) {
  let input: TextareaRenderable | undefined
  const theme = useTheme()
  const enabled = useInteractivity()
  const cursorStyle = useCursorStyle()
  Keymap.createLayer(() => ({
    mode: "base",
    priority: 2,
    commands: [
      { bind: "escape", title: t("tui.permissions.cancel"), run: () => props.onCancel() },
      { bind: "return", title: t("tui.permissions.narrow.confirm"), run: () => props.onConfirm(input?.plainText ?? "") },
    ],
  }))
  return (
    <box
      id="session.permission.narrowed.reject"
      backgroundColor={theme.background.raised.base}
      border={["left"]}
      borderColor={theme.text.feedback.error.base}
      paddingLeft={2}
      paddingRight={3}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      <text fg={theme.text.base}>{t("tui.permissions.narrow.rejectTitle")}</text>
      <text fg={theme.text.muted}>{t("tui.permissions.narrow.rejectHint")}</text>
      <textarea
        ref={(value: TextareaRenderable) => {
          input = value
        }}
        focused={enabled()}
        textColor={theme.text.base}
        focusedTextColor={theme.text.base}
        cursorColor={theme.text.base}
        cursorStyle={cursorStyle()}
      />
    </box>
  )
}

function toolCommand(context: Plugin.Context, request: PermissionRequest) {
  const source = request.source
  if (!source) return undefined
  const message = context.data.session.message.get(request.sessionID, source.messageID)
  if (message?.type !== "assistant") return undefined
  const part = message.content.find((item) => item.type === "tool" && item.id === source.id)
  if (part?.type !== "tool" || part.state.status === "streaming") return undefined
  const command = (part.state.input as Record<string, unknown> | undefined)?.command
  return typeof command === "string" ? command : undefined
}

// The shell parser supplies normalized resources but this client has no source spans. Only trust a unique occurrence
// at a command boundary; quoted or repeated matches fall back to the status list instead of guessing.
function locate(command: string, parts: readonly RequestPart[]) {
  const result = parts.reduce<{ readonly at: number; readonly segments: readonly Segment[] } | undefined>(
    (state, part) => {
      if (!state) return undefined
      const first = command.indexOf(part.resource, state.at)
      const second = first === -1 ? -1 : command.indexOf(part.resource, first + 1)
      if (first === -1 || second !== -1 || !commandBoundary(command, first)) return undefined
      const end = first + part.resource.length
      const gap = first > state.at ? [{ text: command.slice(state.at, first) }] : []
      return { at: end, segments: [...state.segments, ...gap, { text: part.resource, part }] }
    },
    { at: 0, segments: [] },
  )
  if (!result) return undefined
  return result.at < command.length ? [...result.segments, { text: command.slice(result.at) }] : result.segments
}

function commandBoundary(command: string, start: number) {
  return /(?:^|&&|\|\||[;|&()\n])\s*$/.test(command.slice(0, start))
}

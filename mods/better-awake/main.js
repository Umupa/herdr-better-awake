// better-awake: a cup that keeps the computer awake, like Sheprd's status bar cup.
// Click: until clicked again. Right-click: until every agent finishes.
// The hold is a helper process (caffeinate, systemd-inhibit or hold.ps1) that
// watches Herdr's pid, so quitting or crashing Herdr always lets the computer sleep.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, window, shared, setShared, terminals, machines, notify, nextCommand, theme, props, run, checking, appHome } from "herdr";

// { cup: "off" | "pending" | "on", mode: "indefinite" | "agents", scope, app, pid, until }
const KEY = "better-awake";
// What the next hold keeps awake: "display" (default) or "system" (the display may sleep and lock).
const SCOPE = "better-awake.scope";
const ICON = (name) => `mods/better-awake/icons/${name}.svg`;
const DAY = 24 * 3600 * 1000;
const UNIX_HOLDERS = "caffeinate|systemd-inhibit";

// Shared by this build's copies: the one copy that holds and answers commands.
let owner = null;

function state() {
  const s = shared(KEY);
  return s && typeof s === "object" ? s : { cup: "off" };
}

function scopePref() {
  return shared(SCOPE) === "system" ? "system" : "display";
}

function windows() {
  return window()?.platform === "windows";
}

function anyWorking() {
  return terminals().some((t) => t.status === "working");
}

const pidOf = (text) => (/^\d+$/.test(String(text).trim()) ? String(text).trim() : null);

function ps(script) {
  return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15000 });
}

// Herdr's own pid: the parent of a shell it starts.
async function appPid() {
  const r = windows()
    ? await ps('(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId')
    : await exec("sh", ["-c", "echo $PPID"], { timeout: 5000 });
  return pidOf(r.stdout);
}

async function alive(pid) {
  if (!pid) return false;
  const r = windows()
    ? await ps(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`)
    : await exec("sh", ["-c", `ps -p ${pid} -o comm= | grep -qE '${UNIX_HOLDERS}'`], { timeout: 5000 });
  return r.code === 0;
}

// Starts the helper in the background and returns its pid.
async function start(scope, app) {
  const display = scope === "display";
  let r;
  if (windows()) {
    const file = `${appHome()}/mods/better-awake/hold.ps1`;
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `"${file}"`, "-App", app, ...(display ? ["-Display"] : [])];
    r = await ps(`(Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList ${args.map((a) => `'${a}'`).join(",")}).Id`);
  } else if (window()?.platform === "macos") {
    r = await exec("sh", ["-c", `caffeinate -i${display ? " -d" : ""} -w ${app} >/dev/null 2>&1 & echo $!`], { timeout: 5000 });
  } else {
    const what = display ? "idle:sleep" : "sleep";
    r = await exec("sh", ["-c",
      "command -v systemd-inhibit >/dev/null || { echo 'systemd-inhibit not found' >&2; exit 1; }; " +
      `systemd-inhibit --what=${what} --who=Herdr --why='Better Awake' --mode=block ` +
      `sh -c 'while kill -0 ${app} 2>/dev/null; do sleep 2; done' >/dev/null 2>&1 & echo $!`], { timeout: 5000 });
  }
  const pid = pidOf(r.stdout);
  if (r.code !== 0 || !pid) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  return pid;
}

async function stop(pid) {
  if (!pid) return;
  if (windows()) await ps(`Stop-Process -Id ${pid} -ErrorAction SilentlyContinue`);
  else await exec("sh", ["-c", `ps -p ${pid} -o comm= | grep -qE '${UNIX_HOLDERS}' && kill ${pid}; exit 0`], { timeout: 5000 });
}

// "for-30m", "for-2h", "for-90s": a hold that ends on its own.
function duration(command) {
  const m = /^for-(\d+)(s|m|h)$/.exec(command);
  if (!m) return null;
  return Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]];
}

function tip(s) {
  const scope = s.cup === "off" ? scopePref() : s.scope;
  const what = scope === "system" ? "the system" : "the display";
  if (s.cup === "on" && s.mode === "agents") return `Keeping ${what} awake until agents finish`;
  if (s.cup === "on") return `Keeping ${what} awake · Right-click: until agents finish`;
  return `Keep ${what} awake · Right-click: until agents finish`;
}

export default class BetterAwake extends View {
  init(_props, cx) {
    // props {headless: true}: hold and answer commands, draw nothing (another mod draws the cup).
    this.headless = Boolean(props()?.headless);
    if (checking()) return;
    this.ready = false;
    this.busy = false;
    this.checkedAt = 0;
    this.claim(cx);
    cx.timer.every(1000, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (owner === this && this.ready && !this.busy) {
          this.busy = true;
          try { await this.command(c); } finally { this.busy = false; }
        }
        cx.notify();
      }
    });
  }

  claim(cx) {
    if (owner) return;
    owner = this;
    cx.spawn(async (cx) => {
      this.app = await appPid().catch(() => null);
      cx.notify();
      // A hold from this run of Herdr (a mod reload) is kept; one from an earlier run died with it.
      const s = state();
      const ours = s.cup === "on" && s.app === this.app && await alive(s.pid);
      if (!ours && s.cup !== "off") setShared(KEY, { cup: "off" });
      this.ready = true;
      cx.notify();
    });
  }

  async close() {
    if (owner === this) owner = null;
  }

  tick(cx) {
    if (!owner) this.claim(cx);
    if (owner !== this || !this.ready || this.busy) return;
    const s = state();
    if (s.cup !== "on") return;
    const now = Date.now();
    if (s.until && now >= s.until) return this.run(cx, () => this.release());
    // A loading machine's agents can't be read yet: keep holding until they can.
    if (s.mode === "agents" && !anyWorking() && !machines().some((m) => m.layout === "loading")) {
      return this.run(cx, () => this.release());
    }
    if (now - this.checkedAt > 5000) {
      this.checkedAt = now;
      this.run(cx, async () => {
        if (state().cup === "on" && !(await alive(state().pid))) {
          setShared(KEY, { cup: "off" });
          notify({ title: "Better Awake stopped", body: "The keep-awake helper ended; the computer may sleep.", level: "warning" });
        }
      });
    }
  }

  run(cx, work) {
    this.busy = true;
    cx.spawn(async (cx) => {
      try { await work(); } finally { this.busy = false; cx.notify(); }
    });
  }

  async command(c) {
    if (c === "display" || c === "system") return setShared(SCOPE, c);
    if (c === "scope") return setShared(SCOPE, scopePref() === "display" ? "system" : "display");
    const s = state();
    if (s.cup === "pending") return;
    const on = s.cup === "on";
    const ms = duration(c);
    if (ms !== null) {
      if (ms < 1000 || ms > DAY) return notify({ title: "Better Awake", body: "A timed hold lasts between one second and a day.", level: "warning" });
      const until = Date.now() + ms;
      return on ? setShared(KEY, { ...s, mode: "indefinite", until }) : this.hold("indefinite", until);
    }
    switch (c) {
      case "toggle":
        return on ? this.release() : this.hold("indefinite");
      case "on":
        return on ? setShared(KEY, { ...s, mode: "indefinite", until: null }) : this.hold("indefinite");
      case "off":
        return on ? this.release() : undefined;
      case "agents":
        if (on && s.mode === "agents") return this.release();
        if (!anyWorking()) return notify({ title: "Better Awake", body: "No agent is working, so there is nothing to stay awake for.", level: "warning" });
        return on ? setShared(KEY, { ...s, mode: "agents", until: null }) : this.hold("agents");
    }
  }

  async hold(mode, until = null) {
    const scope = scopePref();
    const app = this.app ?? (this.app = await appPid());
    setShared(KEY, { cup: "pending", mode, scope });
    try {
      if (!app) throw new Error("could not find Herdr's process");
      const pid = await start(scope, app);
      setShared(KEY, { cup: "on", mode, scope, app, pid, until });
    } catch (e) {
      setShared(KEY, { cup: "off" });
      notify({ title: "Could not keep the computer awake", body: String(e?.message ?? e), level: "error" });
    }
  }

  async release() {
    const s = state();
    setShared(KEY, { ...s, cup: "pending" });
    try { await stop(s.pid); } catch { /* it is gone already */ }
    setShared(KEY, { cup: "off" });
  }

  cup(t) {
    const s = state();
    const on = s.cup === "on";
    const color = on ? t.accent : s.cup === "pending" ? t.dim : t.muted;
    return h_flex().id("better-awake").h_full().px(6).items_center().cursor_pointer().rounded(4)
      .hover((st) => st.bg(t.hover))
      .tooltip(tip(s))
      .on_click(() => run("better-awake.toggle"))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); run("better-awake.agents"); })
      .child(div().relative()
        .child(svg(ICON(on ? "cup-full" : "cup")).size(13).text_color(color))
        // The dot marks a hold that ends on its own when the agents finish.
        .when(on && s.mode === "agents", (el) => el.child(
          div().absolute().right(-1).bottom(0).size(6).rounded(3).border_1().border_color(t.chrome).bg(color))));
  }

  render() {
    if (this.headless) return div();
    const t = theme();
    return h_flex().size_full().items_center().justify_center().bg(t.chrome).border_t(1).border_color(t.border)
      .child(this.cup(t));
  }
}

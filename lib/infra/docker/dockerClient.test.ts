// DockerClient is the chokepoint for every non-streaming tool and every root exec. Pins that capture
// stays bounded (a throw in its handlers would exit the server) and that root execs get a fixed env.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IDockerClient } from "./dockerClient";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn }));

const { DockerClient } = await import("./dockerClient");

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: PassThrough;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new PassThrough();
  return proc;
}

beforeEach(() => spawn.mockReset());

describe("DockerClient output capture", () => {
  it("keeps modest output whole and does not flag it", async () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const p = new DockerClient().exec("ws_1", ["cat", "small.txt"]);
    proc.stdout.emit("data", Buffer.from("file contents"));
    proc.emit("close", 0);

    expect(await p).toEqual({ stdout: "file contents", stderr: "", code: 0, truncated: false });
  });

  it("stops capturing at the ceiling instead of growing without bound", async () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const p = new DockerClient().exec("ws_1", ["cat", "huge.bin"]);
    // 64MB in 1MB chunks — the "write a large file, read it back" path, in two tool calls.
    for (let i = 0; i < 64; i++) proc.stdout.emit("data", Buffer.alloc(1024 * 1024, 0x61));
    proc.emit("close", 0);

    const r = await p;
    expect(r.truncated).toBe(true);
    // Held at the 8MB ceiling rather than the 64MB that was produced.
    expect(Buffer.byteLength(r.stdout)).toBe(8 * 1024 * 1024);
  });

  it("caps stderr on its own budget, so a noisy failure cannot slip past", async () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const p = new DockerClient().exec("ws_1", ["false"]);
    for (let i = 0; i < 16; i++) proc.stderr.emit("data", Buffer.alloc(1024 * 1024, 0x62));
    proc.emit("close", 1);

    const r = await p;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stderr)).toBe(8 * 1024 * 1024);
  });

  it("still reports a spawn failure rather than throwing", async () => {
    // Once, not permanently: a throwing implementation left in place outlives the call and gets
    // re-entered during teardown, which surfaces as this test failing on an error it already handled.
    spawn.mockImplementationOnce(() => {
      throw new Error("EBADF");
    });

    // Pre-existing behaviour worth keeping: spawn can throw synchronously during Next compilation.
    await expect(new DockerClient().exec("ws_1", ["ls"])).resolves.toMatchObject({ code: 1, stderr: "EBADF" });
  });
});

const ROOT_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"];

function runExec(...args: Parameters<IDockerClient["exec"]>) {
  const proc = fakeProc();
  spawn.mockReturnValue(proc);
  const p = new DockerClient().exec(...args);
  proc.emit("close", 0);
  return p;
}

// The spawned argv, split at the container name into docker's own flags and what runs inside.
function spawned() {
  const args: string[] = spawn.mock.calls[0][1];
  const at = args.indexOf("ws_1");
  const flags = args.slice(0, at);
  const env = flags.filter((_, i) => flags[i - 1] === "-e");
  return { flags, env, cwd: flags[flags.indexOf("-w") + 1], inside: args.slice(at + 1) };
}

describe("DockerClient root execs", () => {
  it("runs the command through the env wrapper with its argv unchanged", async () => {
    await runExec("ws_1", ["apt-get", "install", "-y", "jq"], { asRoot: true });
    const { flags, inside } = spawned();
    expect(flags).toEqual(expect.arrayContaining(["-u", "0"]));
    expect(inside.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(inside.slice(-4)).toEqual(["apt-get", "install", "-y", "jq"]);
  });

  it("pins PATH, HOME and DEBIAN_FRONTEND, and runs from / rather than the agent's workspace", async () => {
    await runExec("ws_1", ["true"], { asRoot: true });
    const { env, cwd } = spawned();
    expect(env).toEqual(expect.arrayContaining([`PATH=${ROOT_PATH}`, "HOME=/root", "DEBIAN_FRONTEND=noninteractive"]));
    expect(cwd).toBe("/");
  });

  it("lets a caller add vars but never override the fixed ones", async () => {
    await runExec("ws_1", ["true"], {
      asRoot: true,
      env: { PATH: "/home/dev/.pyenv/bin", http_proxy: "http://u:s@x" },
    });
    const { env } = spawned();
    expect(env.filter((e) => e.startsWith("PATH="))).toEqual([`PATH=${ROOT_PATH}`]);
    expect(env).toContain("http_proxy=http://u:s@x");
  });

  it("keeps only the fixed vars, the caller's and the egress route", async () => {
    await runExec("ws_1", ["true"], { asRoot: true, env: { MY_VAR: "1" } });
    const keep = spawned().inside[4].split(" ");
    expect(new Set(keep)).toEqual(new Set(["MY_VAR", "PATH", "HOME", "DEBIAN_FRONTEND", ...PROXY_VARS]));
  });

  it("never puts an env value in the argv, which the agent can read from /proc", async () => {
    await runExec("ws_1", ["true"], { asRoot: true, env: { http_proxy: "http://u:SECRET@x" } });
    expect(spawned().inside.join(" ")).not.toContain("SECRET");
  });

  it("leaves a non-root exec in the container's own env and workspace", async () => {
    await runExec("ws_1", ["ls"], { env: { A: "1" } });
    const { flags, env, cwd, inside } = spawned();
    expect(flags).not.toContain("-u");
    expect(env).toEqual(["A=1"]);
    expect(cwd).toBe("/workspace");
    expect(inside).toEqual(["ls"]);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codexConfinementArgs } from "./codexProfile.js";

const identity = (p: string) => p;

describe("codexConfinementArgs", () => {
  it("emits the exact flag array for a fixed set of inputs", () => {
    const args = codexConfinementArgs("/ws/copy", {
      homedir: "/home/tester",
      tmpdir: "/scratch/tmp",
      realpath: identity,
    });

    assert.deepEqual(args, [
      "-c",
      'default_permissions="agent_flows"',
      "-c",
      'permissions.agent_flows.extends=":read-only"',
      "-c",
      'permissions.agent_flows.filesystem={"/Users"="deny","/Volumes"="deny","/tmp"="deny",' +
        '"/private/tmp"="deny","/etc"="deny","/private/etc"="deny","/var/folders"="deny",' +
        '"/private/var/folders"="deny","/Library"="deny","/Applications"="deny",' +
        '"/opt/homebrew/etc"="deny","/usr/local/etc"="deny","/private/var"="deny",' +
        '"/nix"="deny","/srv"="deny","/root"="deny","/home/tester"="deny","/scratch"="deny",' +
        '"/ws/copy"="read"}',
    ]);
  });

  // A root missing here is a readable path on the machine; a root too broad here
  // makes the tools a step runs unexecutable. Both are regressions worth pinning.
  it("denies the config subtrees of /opt and /usr/local, never the prefixes", () => {
    const args = codexConfinementArgs("/ws/copy", {
      homedir: "/home/tester",
      tmpdir: "/scratch/tmp",
      realpath: identity,
    });
    const denies = [...args[args.length - 1].matchAll(/"([^"]+)"="deny"/g)].map((m) => m[1]);

    for (const root of [
      "/Users",
      "/Volumes",
      "/Library",
      "/Applications",
      "/opt/homebrew/etc",
      "/usr/local/etc",
      "/private/var",
      "/nix",
      "/srv",
      "/root",
    ]) {
      assert.ok(denies.includes(root), `${root} must be denied; got: ${denies.join(", ")}`);
    }

    // Denying /opt breaks `execvp` for /opt/homebrew/bin/*; /usr/local is the
    // same shape on Intel machines.
    assert.equal(denies.includes("/opt"), false, "/opt must never be denied wholesale");
    assert.equal(denies.includes("/usr/local"), false, "/usr/local must never be denied wholesale");
  });

  it("never emits -s", () => {
    const args = codexConfinementArgs("/ws/copy", { realpath: identity });
    assert.equal(
      args.some((arg) => arg === "-s" || arg === "--sandbox"),
      false
    );
  });

  it("never denies /", () => {
    const args = codexConfinementArgs("/ws/copy", {
      // Both would otherwise contribute `/`: a home of `/` and a tmpdir whose
      // parent is `/`. A deny on `/` aborts the sandboxed process.
      homedir: "/",
      tmpdir: "/tmp",
      realpath: identity,
    });

    const map = args[args.length - 1];
    assert.equal(map.includes('"/"="deny"'), false);
    assert.equal(map.includes('"/"='), false);
  });

  it("realpath-resolves the grant and the deny roots", () => {
    const realpath = (p: string) =>
      p.startsWith("/var/") ? p.replace("/var/", "/private/var/") : p;
    const args = codexConfinementArgs("/var/folders/ab/cd/T/agent-flows-ws-1", {
      homedir: "/home/tester",
      tmpdir: "/home/tester/tmp",
      realpath,
    });

    const map = args[args.length - 1];
    assert.ok(map.includes('"/private/var/folders/ab/cd/T/agent-flows-ws-1"="read"'));
    assert.equal(map.includes('"/var/folders/ab/cd/T/agent-flows-ws-1"="read"'), false);
  });

  it("adds no duplicate root for a tmpdir already under /var/folders", () => {
    const args = codexConfinementArgs("/ws/copy", {
      homedir: "/home/tester",
      tmpdir: "/private/var/folders/ab/cd/T",
      realpath: identity,
    });

    const map = args[args.length - 1];
    const denies = [...map.matchAll(/"([^"]+)"="deny"/g)].map((m) => m[1]);
    assert.deepEqual(denies, [...new Set(denies)], "deny roots must be unique");
    assert.equal(
      denies.some((d) => d.startsWith("/private/var/folders/ab")),
      false,
      "a tmpdir parent under an existing root must not be added"
    );
  });

  it("quotes paths containing spaces", () => {
    const args = codexConfinementArgs("/ws/my copy", {
      homedir: "/home/my user",
      tmpdir: "/scratch/tmp",
      realpath: identity,
    });

    const map = args[args.length - 1];
    assert.ok(map.includes('"/home/my user"="deny"'));
    assert.ok(map.includes('"/ws/my copy"="read"'));
  });

  it("falls back to the literal path when realpath throws", () => {
    const realpath = (p: string) => {
      if (p === "/ws/missing") throw new Error("ENOENT");
      return p;
    };
    const args = codexConfinementArgs("/ws/missing", {
      homedir: "/home/tester",
      tmpdir: "/scratch/tmp",
      realpath,
    });

    assert.ok(args[args.length - 1].includes('"/ws/missing"="read"'));
  });
});

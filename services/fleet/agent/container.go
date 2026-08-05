package main

// Image handling and the sandbox lifecycle.
//
// containerd is used for what it is good at — pulling images, unpacking layers,
// and handing back a copy-on-write snapshot — and for nothing else. The task API
// and its shim are deliberately not used.
//
// That is not a stylistic preference. On this exact stack (Ubuntu 24.04,
// containerd 1.7.29 and 2.2.6 both tried, gVisor release-20260727.0) every
// container started through `io.containerd.runsc.v1` boots its sandbox, reaches
// `created`, and never reaches `running`: the shim sits idle in epoll with a
// healthy gofer and boot process beneath it, containerd's Start never completes,
// and 40s later it reports `failed to delete task: context deadline exceeded`.
// The same image runs under runc through the same containerd, and `runsc start`
// on the very same bundle succeeds by hand in 20 milliseconds with exit 0.
//
// So the agent drives runsc directly. It has to supervise processes, own
// cgroups, own namespaces and own the freeze path regardless — the shim was
// duplicating a supervisor we were going to write anyway, and it was the only
// part of the stack that did not work.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/core/leases"
	"github.com/containerd/containerd/v2/core/mount"
	"github.com/containerd/containerd/v2/core/remotes"
	"github.com/containerd/containerd/v2/core/remotes/docker"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	specs "github.com/opencontainers/runtime-spec/specs-go"
)

const (
	containerdSock = "/run/containerd/containerd.sock"
	ctrNamespace   = "supersonic"
	runscBin       = "/usr/local/bin/runsc"
	runscRoot      = "/run/supersonic/runsc"
	bundleRoot     = "/srv/state/bundles"
	// Where app secrets live. The placement spec carries bare secret ids so it
	// stays portable across projects; this is the one place the project appears.
	gcpProject = "supersonic-deploy-prod"
)

type Runtime struct {
	cd *client.Client
}

func NewRuntime() (*Runtime, error) {
	cd, err := client.New(containerdSock, client.WithDefaultNamespace(ctrNamespace))
	if err != nil {
		return nil, fmt.Errorf("containerd: %w", err)
	}
	for _, d := range []string{runscRoot, bundleRoot} {
		if err := os.MkdirAll(d, 0o711); err != nil {
			return nil, err
		}
	}
	return &Runtime{cd: cd}, nil
}

func (r *Runtime) ctx() context.Context {
	return namespaces.WithNamespace(context.Background(), ctrNamespace)
}

// resolver authenticates to Artifact Registry with the node's own service
// account token, fetched from the metadata server.
//
// The nftables rule from provision.sh allows uid 0 and 987 to reach the
// credentials API and denies everyone else, so this call works for the agent and
// fails for every tenant — which is the whole point of running the agent as a
// known uid.
func (r *Runtime) resolver() remotes.Resolver {
	return docker.NewResolver(docker.ResolverOptions{
		Hosts: docker.ConfigureDefaultRegistries(
			docker.WithAuthorizer(docker.NewDockerAuthorizer(
				docker.WithAuthCreds(func(host string) (string, string, error) {
					if !strings.HasSuffix(host, "docker.pkg.dev") && !strings.HasSuffix(host, "gcr.io") {
						return "", "", nil
					}
					tok, err := metadataToken()
					if err != nil {
						return "", "", err
					}
					return "oauth2accesstoken", tok, nil
				}),
			)),
		),
	})
}

// EnsureImage pulls the image if it is not already present, and unpacks it into
// the snapshotter so a snapshot can be taken from it.
func (r *Runtime) EnsureImage(ref string) (client.Image, error) {
	ctx := r.ctx()
	if img, err := r.cd.GetImage(ctx, ref); err == nil {
		// Present in the content store is not the same as unpacked. A node that
		// pulled an image and then lost its snapshots would otherwise fail at
		// snapshot time with a much less obvious error.
		if ok, uerr := img.IsUnpacked(ctx, ""); uerr == nil && ok {
			return img, nil
		}
		if uerr := img.Unpack(ctx, ""); uerr == nil {
			return img, nil
		}
	}
	img, err := r.cd.Pull(ctx, ref,
		client.WithPullUnpack,
		client.WithResolver(r.resolver()),
	)
	if err != nil {
		return nil, fmt.Errorf("pull %s: %w", ref, err)
	}
	return img, nil
}

// leaseID turns a sandbox id into something containerd will accept as a lease id.
//
// Sandbox ids are `<slug>--<process>.` (process.go), and containerd validates
// lease ids against `^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$` — which `gzz9j--release.`
// fails twice over, on the doubled separator and on the trailing dot. Snapshot
// KEYS have no such rule, which is why the id has always been fine there and is
// not fine here.
//
// Sanitising alone would collide: `subio-2--web.` and a hypothetical `subio` with
// a `2-web` process both flatten to `subio-2-web`. The short digest of the
// ORIGINAL id makes it unique, and keeps the function pure — `Stop` has to derive
// the same lease id from the same sandbox id with no stored state, because it is
// also called on a cold boot to clear wreckage left by a process that is gone.
func leaseID(id string) string {
	sum := sha256.Sum256([]byte(id))
	var b strings.Builder
	prevSep := true // leading separators are not allowed either
	for _, c := range id {
		switch {
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'):
			b.WriteRune(c)
			prevSep = false
		case !prevSep:
			b.WriteByte('-')
			prevSep = true
		}
	}
	base := strings.Trim(b.String(), "-")
	if base == "" {
		base = "sandbox"
	}
	// 76 is containerd's cap; the digest and its separator take 9.
	if len(base) > 60 {
		base = strings.Trim(base[:60], "-")
	}
	return base + "-" + hex.EncodeToString(sum[:4])
}

// prepareRootfs takes a writable snapshot of the image and mounts it at
// <bundle>/rootfs.
//
// The snapshot is held by a LEASE, and that is not a refinement — without it the
// sandbox cannot be started at all on a node that is pulling images.
//
// An active snapshot with nothing referencing it is garbage to containerd, and
// its collector deletes it. That deletes the overlay's UPPERDIR while the mount
// itself stays in place, and a mounted overlay whose upper layer is gone answers
// every write with ENOENT — which runsc reports as "creating gofer filestore
// files: failed to create filestore file inside <rootfs>: no such file or
// directory". The message names the rootfs, the rootfs exists, and the thing that
// is missing is one directory below it in another tree entirely.
//
// Found on 2026-08-05 by the first app the pipeline ever placed that declared a
// release process. The node held 246 snapshots, 0 of them active, and 0 leases —
// including for the twenty-one sandboxes that were running at the time. Those
// survive because their files are already open; only a NEW start needs the upper
// layer to still be there, which is why a node can look perfectly healthy and be
// unable to start anything. The apps that did work were pulled long ago; a fresh
// image pull is itself what makes the collector run, so a deploy of new code is
// the case most likely to lose the race.
//
// The lease has no expiration on purpose: it must outlive an arbitrarily
// long-running app, and an expiry short enough to bound a leak would be short
// enough to reintroduce the bug. `Stop` deletes it, and `ctr -n supersonic leases
// ls` is where a leak from an agent killed mid-start would show.
func (r *Runtime) prepareRootfs(id string, img client.Image, bundle string) error {
	ctx := r.ctx()
	diffIDs, err := img.RootFS(ctx)
	if err != nil {
		return fmt.Errorf("rootfs: %w", err)
	}
	parent := identityChainID(diffIDs)

	rootfs := filepath.Join(bundle, "rootfs")
	// A previous sandbox's mount can survive an ungraceful stop, and mounting the
	// new snapshot on top of it stacks mounts.
	runOK("umount", "-l", rootfs)
	if err := os.MkdirAll(rootfs, 0o755); err != nil {
		return err
	}

	sn := r.cd.SnapshotService("")
	// Remove a stale snapshot under the same key first. After an ungraceful stop
	// the key survives, and Prepare would fail with "already exists" on every
	// subsequent start — an app that can never come back without manual cleanup.
	_ = sn.Remove(ctx, id)

	// Same reasoning for the lease: a leftover one makes Create fail with
	// "already exists", and then every start of this sandbox fails forever.
	lm := r.cd.LeasesService()
	lid := leaseID(id)
	_ = lm.Delete(ctx, leases.Lease{ID: lid})
	if _, err := lm.Create(ctx, leases.WithID(lid)); err != nil {
		return fmt.Errorf("snapshot lease: %w", err)
	}

	// Prepare UNDER the lease. `leases.WithLease` is what puts the new snapshot
	// out of the collector's reach; calling Prepare on the plain context is the
	// defect this whole comment is about.
	mounts, err := sn.Prepare(leases.WithLease(ctx, lid), id, parent)
	if err != nil {
		return fmt.Errorf("snapshot prepare: %w", err)
	}
	if err := mount.All(mounts, rootfs); err != nil {
		return fmt.Errorf("mount rootfs: %w", err)
	}
	return nil
}

// imageConfig returns the entrypoint, cmd, env and workdir baked into the image,
// so an app that declares no command runs what its Dockerfile said.
func (r *Runtime) imageConfig(img client.Image) (entrypoint, cmd, env []string, cwd string, err error) {
	ctx := r.ctx()
	cfgDesc, err := img.Config(ctx)
	if err != nil {
		return nil, nil, nil, "", err
	}
	blob, err := content_ReadBlob(ctx, r.cd, cfgDesc)
	if err != nil {
		return nil, nil, nil, "", err
	}
	var ic struct {
		Config struct {
			Entrypoint []string `json:"Entrypoint"`
			Cmd        []string `json:"Cmd"`
			Env        []string `json:"Env"`
			WorkingDir string   `json:"WorkingDir"`
		} `json:"config"`
	}
	if err := json.Unmarshal(blob, &ic); err != nil {
		return nil, nil, nil, "", err
	}
	return ic.Config.Entrypoint, ic.Config.Cmd, ic.Config.Env, ic.Config.WorkingDir, nil
}

// writeSpec generates the OCI runtime spec for one app.
//
// Precedence, lowest first: the image's own ENV, then PORT, then the app's
// declared env, then resolved secrets. Secrets win because a secret and a plain
// variable with the same name means someone promoted a value to a secret and the
// plain one is the stale copy.
func writeSpec(bundle string, app App, proc Process, net *SandboxNet, imgEnv []string, argv []string, cwd string,
	secrets map[string]string) error {
	if cwd == "" {
		cwd = "/"
	}

	env := append([]string{}, imgEnv...)
	// PORT is set for every kind, not only web. A worker that never binds it is
	// unaffected, and a framework that reads it at import time — which many do,
	// before knowing whether it will serve — does not crash on a missing value.
	env = append(env, fmt.Sprintf("PORT=%d", effectivePort(app, proc)))
	for k, v := range app.Env {
		env = append(env, k+"="+v)
	}
	for k, v := range secrets {
		env = append(env, k+"="+v)
	}

	spec := specs.Spec{
		Version: specs.Version,
		Process: &specs.Process{
			Terminal: false,
			User:     specs.User{UID: 0, GID: 0},
			Args:     argv,
			Env:      env,
			Cwd:      cwd,
			// No added capabilities. Cloud Run gave these apps none either, so
			// this is not a new constraint on anything that runs today.
			Capabilities: &specs.LinuxCapabilities{
				Bounding:  []string{"CAP_NET_BIND_SERVICE"},
				Effective: []string{"CAP_NET_BIND_SERVICE"},
				Permitted: []string{"CAP_NET_BIND_SERVICE"},
			},
			NoNewPrivileges: true,
		},
		Root:     &specs.Root{Path: "rootfs", Readonly: false},
		Hostname: app.Slug,
		Mounts: []specs.Mount{
			{Destination: "/proc", Type: "proc", Source: "proc"},
			{Destination: "/dev", Type: "tmpfs", Source: "tmpfs",
				Options: []string{"nosuid", "strictatime", "mode=755", "size=65536k"}},
			{Destination: "/dev/pts", Type: "devpts", Source: "devpts",
				Options: []string{"nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"}},
			{Destination: "/dev/shm", Type: "tmpfs", Source: "shm",
				Options: []string{"nosuid", "noexec", "nodev", "mode=1777", "size=65536k"}},
			{Destination: "/tmp", Type: "tmpfs", Source: "tmpfs",
				Options: []string{"nosuid", "nodev", "mode=1777"}},
			{Destination: "/sys", Type: "sysfs", Source: "sysfs",
				Options: []string{"nosuid", "noexec", "nodev", "ro"}},
			// Resolver config. The sandbox has its own netstack and no inherited
			// /etc/resolv.conf, so without this every name lookup inside an app
			// fails while the network itself is perfectly fine.
			{Destination: "/etc/resolv.conf", Type: "bind", Source: resolvConfPath,
				Options: []string{"rbind", "ro"}},
		},
		Linux: &specs.Linux{
			Namespaces: []specs.LinuxNamespace{
				{Type: specs.PIDNamespace},
				{Type: specs.MountNamespace},
				{Type: specs.IPCNamespace},
				{Type: specs.UTSNamespace},
				// The network namespace is a PATH, not a fresh namespace: the
				// agent built it, addressed it, and put it on the bridge before
				// the sandbox existed.
				{Type: specs.NetworkNamespace, Path: net.Path},
			},
			Resources: &specs.LinuxResources{
				Memory: &specs.LinuxMemory{
					Limit: int64ptr(proc.MemoryBytes),
				},
				CPU: &specs.LinuxCPU{
					// Shares, not a quota. An idle fleet should let one bursting
					// app use the box; a quota would make it slow while fifteen
					// cores sit idle.
					Shares: uint64ptr(proc.CPUShares),
				},
				Pids: &specs.LinuxPids{Limit: 2048},
			},
			CgroupsPath: "/supersonic/" + sandboxID(app.Slug, proc),
		},
	}

	if app.DataDir != "" {
		spec.Mounts = append(spec.Mounts, specs.Mount{
			Destination: "/data", Type: "bind", Source: app.DataDir,
			Options: []string{"rbind", "rw"},
		})
	}

	b, err := json.MarshalIndent(&spec, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(bundle, "config.json"), b, 0o644)
}

// --- runsc lifecycle -------------------------------------------------------

// runsc runs a runsc subcommand and returns its STDOUT only.
//
// Not CombinedOutput. runsc writes host-setting advisories and other warnings to
// stderr on most invocations, and merging those into stdout makes `runsc state`
// return warnings-then-JSON, which fails to parse — so the agent decides the
// sandbox never reached "running" while it is in fact serving traffic.
func runsc(args ...string) (string, error) {
	full := append([]string{"--root=" + runscRoot}, args...)
	cmd := exec.Command(runscBin, full...)
	var errBuf strings.Builder
	cmd.Stderr = &errBuf
	out, err := cmd.Output()
	if err != nil {
		return string(out), fmt.Errorf("runsc %s: %w: %s",
			strings.Join(args, " "), err, strings.TrimSpace(errBuf.String()))
	}
	return string(out), nil
}

// runscDetached starts a sandbox and returns as soon as runsc has forked it.
//
// The child's stdio is wired to a real file rather than to a pipe, and that is
// the whole point of this function existing separately. exec.Command's pipe
// plumbing waits for EOF on the read end, and a DETACHED sandbox inherits the
// write end and holds it open for its entire life — so the agent blocks forever
// on a call that already succeeded, with the app running and nothing logged.
// The symptom is an agent that appears hung on its first app and a sandbox that
// is demonstrably serving.
//
// Pointing that file at the app's log is not a workaround; it is where the app's
// stdout has to go anyway.
func runscDetached(bundle, id, logPath string) error {
	// The DIRECTORY, not just the file. O_CREATE makes the file; it does not make
	// the path to it.
	//
	// This belongs here rather than at the call sites because the start path
	// already did it and the release path did not, and the release runs FIRST.
	// Observed on 2026-08-04, on the first cold boot this node had ever had:
	// local SSD does not survive a stop, so /srv came back empty, and an app
	// declaring a `release` process failed here every 10 seconds forever —
	// `a.released[slug]` is only set on success, so the reconcile loop retried
	// it on every pass and the app never started at all. Nineteen apps came
	// back; that one did not.
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return fmt.Errorf("app log dir: %w", err)
	}
	lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return fmt.Errorf("open app log: %w", err)
	}
	defer lf.Close()

	cmd := exec.Command(runscBin, "--root="+runscRoot,
		"run", "--detach", "--bundle", bundle, id)
	cmd.Stdin = nil
	cmd.Stdout = lf
	cmd.Stderr = lf
	if err := cmd.Run(); err != nil {
		tail, _ := os.ReadFile(logPath)
		if len(tail) > 800 {
			tail = tail[len(tail)-800:]
		}
		return fmt.Errorf("runsc run --detach %s: %w: %s", id, err, strings.TrimSpace(string(tail)))
	}
	return nil
}

type runscState struct {
	ID     string `json:"id"`
	Pid    int    `json:"pid"`
	Status string `json:"status"`
}

// runscStatusFn is the liveness read reconcileOnce makes, behind a package
// variable so a test can drive that pass without a sandbox — the same seam
// shape secretManagerBase and tokenSource use in secrets.go.
//
// Only the reconcile call goes through it. Start's own poll stays on the direct
// function: it is the code that decides a sandbox came up at all, and a test
// that could make it lie would be a test that could invent a running process.
var runscStatusFn = runscStatus

func runscStatus(id string) (runscState, error) {
	out, err := runsc("state", id)
	if err != nil {
		return runscState{}, err
	}
	var st runscState
	if err := json.Unmarshal([]byte(out), &st); err != nil {
		return runscState{}, fmt.Errorf("parse state: %w", err)
	}
	return st, nil
}

// Start brings one PROCESS of an app up: image, rootfs, network, spec, sandbox.
//
// Every kind takes this path. A worker differs from a web process only in having
// no port to publish and nothing to health-check, and a cron differs only in
// being started by a clock and waited on. That is the whole point of the model:
// one primitive, four policies.
func (r *Runtime) Start(app App, proc Process, index int) (*SandboxNet, error) {
	id := sandboxID(app.Slug, proc)
	bundle := filepath.Join(bundleRoot, id)

	img, err := r.EnsureImage(app.Image)
	if err != nil {
		return nil, err
	}

	// A leftover sandbox under this id makes every later step fail confusingly.
	r.Stop(id)

	if err := os.MkdirAll(bundle, 0o711); err != nil {
		return nil, err
	}
	if err := r.prepareRootfs(id, img, bundle); err != nil {
		return nil, err
	}

	entrypoint, cmd, imgEnv, cwd, err := r.imageConfig(img)
	if err != nil {
		return nil, fmt.Errorf("image config: %w", err)
	}
	// The image's own entrypoint is the web process's command by default —
	// that is what the Dockerfile said to run. Every other kind MUST declare
	// one, because the image's CMD is the web server and starting a worker with
	// it would silently run a second copy of the site.
	argv := append(append([]string{}, entrypoint...), cmd...)
	if len(proc.Command) > 0 {
		argv = proc.Command
	} else if proc.Kind != KindWeb {
		return nil, fmt.Errorf("%s: a %s process must declare a command", id, proc.Kind)
	}
	if len(argv) == 0 {
		return nil, fmt.Errorf("%s: image declares no entrypoint or cmd and the process declares no command", id)
	}

	// Checked before secrets are even fetched, let alone the namespace created:
	// if the node's own proxy is down, every database-backed app on it is about
	// to fail the same way, and there is no point spending a Secret Manager round
	// trip — or a namespace this function would then have to tear back down — on
	// a start that cannot succeed. Apps with no database skip this entirely.
	if hasDatabase(app) {
		if err := dbPathReachable(dbProxyAddr, 3*time.Second); err != nil {
			return nil, fmt.Errorf("%s: %w", id, err)
		}
	}

	// Resolve secrets BEFORE the namespace exists, so a missing binding fails
	// cheaply and leaves nothing to clean up. An app whose DATABASE_URL cannot be
	// read must not start: it would come up, fail every request, and still pass a
	// health check on "/".
	resolved, err := resolveAll(gcpProject, app.Secrets)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", id, err)
	}

	net, err := SetupSandboxNet(id, index)
	if err != nil {
		return nil, err
	}

	if err := writeSpec(bundle, app, proc, net, imgEnv, argv, cwd, resolved); err != nil {
		TeardownSandboxNet(id)
		return nil, err
	}

	// `run --detach` rather than create-then-start: one call, and the failure
	// mode we spent the evening on was precisely the gap between those two.
	// One log file per PROCESS, not per app. Sharing one file interleaves a web
	// server's request log with a worker's output and a migration's, and the
	// first thing anyone does with these is read them.
	logPath := processLogPath(app, proc)
	if err := runscDetached(bundle, id, logPath); err != nil {
		TeardownSandboxNet(id)
		return nil, err
	}

	// Confirm it actually reached running rather than trusting the exit code.
	//
	// `runsc state` is consulted first but is NOT the only authority. It returns
	// an error for a short window right after `run --detach` on a sandbox that is
	// already up, and treating that as failure was costing us the app twice over:
	// the start was declared failed, the still-running sandbox was left behind,
	// and every subsequent attempt collided with it ("cannot lock container
	// metadata file: container already exists") forever. `runsc list` is the
	// cross-check, and agreeing with either is enough.
	deadline := time.Now().Add(30 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		st, err := runscStatus(id)
		if err == nil && st.Status == "running" {
			return net, nil
		}
		if err != nil {
			lastErr = err
			for _, known := range r.List() {
				if known == id {
					return net, nil
				}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	st, _ := runscStatus(id)
	r.Stop(id)
	return nil, fmt.Errorf("%s: sandbox did not reach running (status %q, last state error: %v)",
		id, st.Status, lastErr)
}

// RunToCompletion starts a process and waits for it to exit. `release` and
// `cron` are both this.
//
// A non-zero exit is an error, and for `release` that has to stop the deploy:
// a migration that failed followed by a web process that starts anyway is how
// an app comes up against a half-migrated database.
func (r *Runtime) RunToCompletion(app App, proc Process, index int, timeout time.Duration) error {
	id := sandboxID(app.Slug, proc)
	if _, err := r.Start(app, proc, index); err != nil {
		return err
	}
	defer r.Stop(id)

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		st, err := runscStatus(id)
		if err != nil {
			// The sandbox is gone. For a short-lived process that usually means
			// it finished and was reaped, which is success by absence — the
			// alternative is failing every fast job.
			return nil
		}
		if st.Status == "stopped" {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("%s: did not finish within %s", id, timeout)
}

// Stop removes a sandbox and everything it holds. Every step tolerates absence:
// this is called on a cold start to clear wreckage as well as on a real stop.
func (r *Runtime) Stop(slug string) {
	_, _ = runsc("kill", slug, "SIGKILL")
	_, _ = runsc("delete", "--force", slug)
	TeardownSandboxNet(slug)

	// Lazy umount: a gofer that has not finished dying still holds the mount, and
	// a plain umount fails with EBUSY. Lazy detaches now and lets the kernel
	// finish when the last reference goes, which is what makes the subsequent
	// RemoveAll actually remove something.
	bundle := filepath.Join(bundleRoot, slug)
	runOK("umount", "-l", filepath.Join(bundle, "rootfs"))
	_ = os.RemoveAll(bundle)

	ctx := r.ctx()
	_ = r.cd.SnapshotService("").Remove(ctx, slug)
	// After the snapshot, not before: the lease exists to keep the collector off
	// that snapshot, and dropping it first would hand the collector a window in
	// which it, rather than this function, decides when the layer goes.
	_ = r.cd.LeasesService().Delete(ctx, leases.Lease{ID: leaseID(slug)}, leases.SynchronousDelete)
}

// List returns the sandbox ids runsc currently knows about.
func (r *Runtime) List() []string {
	out, err := runsc("list")
	if err != nil {
		return nil
	}
	ids := []string{}
	for i, line := range strings.Split(out, "\n") {
		if i == 0 || strings.TrimSpace(line) == "" {
			continue // header
		}
		f := strings.Fields(line)
		if len(f) > 0 {
			ids = append(ids, f[0])
		}
	}
	return ids
}

// ReapAll removes every sandbox on the node.
//
// Called once at startup, before the first reconcile. The agent holds its live
// set in memory only, so on restart it knows about nothing — and a sandbox that
// survived its parent is not adoptable: its cgroup, netns slot and routing entry
// are all gone from the agent's view, and the next start collides with it
// ("cannot lock container metadata file: container already exists") on every
// pass, forever.
//
// Reaping is safe because desired state is the source of truth: everything that
// should be running is started again within one reconcile, and anything that
// should not was leaked. It costs a few seconds of downtime on an agent restart,
// which is why the systemd unit uses KillMode=process — a routine agent restart
// does not go through here.
func (r *Runtime) ReapAll() int {
	ids := r.List()
	for _, id := range ids {
		r.Stop(id)
	}
	return len(ids)
}

func int64ptr(v int64) *int64    { return &v }
func uint64ptr(v uint64) *uint64 { return &v }

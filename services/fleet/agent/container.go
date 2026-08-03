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
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/containerd/containerd/v2/client"
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

// prepareRootfs takes a writable snapshot of the image and mounts it at
// <bundle>/rootfs.
func (r *Runtime) prepareRootfs(id string, img client.Image, bundle string) error {
	ctx := r.ctx()
	diffIDs, err := img.RootFS(ctx)
	if err != nil {
		return fmt.Errorf("rootfs: %w", err)
	}
	parent := identityChainID(diffIDs)

	rootfs := filepath.Join(bundle, "rootfs")
	// A previous sandbox's mount can survive an ungraceful stop. Mounting the new
	// snapshot on top of it stacks mounts, and runsc then fails with "failed to
	// create filestore file inside <rootfs>: no such file or directory" — which
	// reads like a missing directory rather than like one directory too many.
	runOK("umount", "-l", rootfs)
	if err := os.MkdirAll(rootfs, 0o755); err != nil {
		return err
	}

	sn := r.cd.SnapshotService("")
	// Remove a stale snapshot under the same key first. After an ungraceful stop
	// the key survives, and Prepare would fail with "already exists" on every
	// subsequent start — an app that can never come back without manual cleanup.
	_ = sn.Remove(ctx, id)

	mounts, err := sn.Prepare(ctx, id, parent)
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
func writeSpec(bundle string, app App, net *SandboxNet, imgEnv []string, argv []string, cwd string,
	secrets map[string]string) error {
	if cwd == "" {
		cwd = "/"
	}

	env := append([]string{}, imgEnv...)
	env = append(env, fmt.Sprintf("PORT=%d", app.Port))
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
		Root: &specs.Root{Path: "rootfs", Readonly: false},
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
					Limit: int64ptr(app.MemoryBytes),
				},
				CPU: &specs.LinuxCPU{
					// Shares, not a quota. An idle fleet should let one bursting
					// app use the box; a quota would make it slow while fifteen
					// cores sit idle.
					Shares: uint64ptr(app.CPUShares),
				},
				Pids: &specs.LinuxPids{Limit: 2048},
			},
			CgroupsPath: "/supersonic/" + app.Slug,
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

// Start brings one app up: image, rootfs, network, spec, sandbox.
func (r *Runtime) Start(app App, index int) (*SandboxNet, error) {
	id := app.Slug
	bundle := filepath.Join(bundleRoot, id)

	img, err := r.EnsureImage(app.Image)
	if err != nil {
		return nil, err
	}

	// A leftover sandbox under this id makes every later step fail confusingly.
	r.Stop(app.Slug)

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
	argv := append(append([]string{}, entrypoint...), cmd...)
	if len(app.Command) > 0 {
		argv = app.Command
	}
	if len(argv) == 0 {
		return nil, fmt.Errorf("%s: image declares no entrypoint or cmd and the app declares no command", id)
	}

	// Resolve secrets BEFORE the namespace exists, so a missing binding fails
	// cheaply and leaves nothing to clean up. An app whose DATABASE_URL cannot be
	// read must not start: it would come up, fail every request, and still pass a
	// health check on "/".
	resolved, err := resolveAll(gcpProject, app.Secrets)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", id, err)
	}

	net, err := SetupSandboxNet(app.Slug, index)
	if err != nil {
		return nil, err
	}

	if err := writeSpec(bundle, app, net, imgEnv, argv, cwd, resolved); err != nil {
		TeardownSandboxNet(app.Slug)
		return nil, err
	}

	// `run --detach` rather than create-then-start: one call, and the failure
	// mode we spent the evening on was precisely the gap between those two.
	if err := runscDetached(bundle, id, app.LogPath); err != nil {
		TeardownSandboxNet(app.Slug)
		return nil, err
	}

	// Confirm it actually reached running rather than trusting the exit code.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if st, err := runscStatus(id); err == nil && st.Status == "running" {
			return net, nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	st, _ := runscStatus(id)
	r.Stop(app.Slug)
	return nil, fmt.Errorf("%s: sandbox did not reach running (last status %q)", id, st.Status)
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
}

func int64ptr(v int64) *int64    { return &v }
func uint64ptr(v uint64) *uint64 { return &v }

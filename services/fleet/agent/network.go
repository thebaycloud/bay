package main

// Per-sandbox networking.
//
// Every sandbox gets its OWN network namespace. This is not optional and it is
// not only about isolation: runsc's netstack claims the interfaces in whatever
// namespace it is handed, so a sandbox sharing the host's namespace is a sandbox
// reaching for the host's NIC.
//
// Shelling out to `ip` rather than using netlink bindings is deliberate. Every
// command here is one a person can paste into a terminal on a broken node and
// watch fail, which is worth more at this stage than saving a fork.

import (
	"fmt"
	"net"
	"os/exec"
	"strings"
)

const (
	bridgeName = "ssbr0"
	// 10.200.0.0/16 — private, and outside GCP's 10.128.0.0/9 default VPC
	// ranges so a sandbox address can never be confused for a node address.
	bridgeCIDR = "10.200.0.1/16"
	subnetMask = 16
)

// netnsName is derived from the slug rather than random, so a leaked namespace
// is attributable to an app by name instead of being an anonymous leak.
func netnsName(slug string) string { return "ss-" + slug }

// vethNames are capped at 15 characters — IFNAMSIZ, and the kernel refuses
// anything longer with a bare EINVAL that reads like a permissions problem.
func vethNames(slug string) (host, peer string) {
	s := slug
	if len(s) > 9 {
		s = s[:9]
	}
	return "vh-" + s, "vs-" + s
}

func run(args ...string) error {
	cmd := exec.Command(args[0], args[1:]...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// runOK runs a command and swallows failure. For teardown only, where "it was
// already gone" and "it could not be removed" are both fine and neither should
// stop the rest of the cleanup.
func runOK(args ...string) { _ = run(args...) }

// EnsureBridge creates the shared bridge and the egress NAT the sandboxes use.
// Idempotent: called on every agent start, including on a node that is already
// serving traffic.
func EnsureBridge() error {
	if err := run("ip", "link", "show", bridgeName); err != nil {
		if err := run("ip", "link", "add", bridgeName, "type", "bridge"); err != nil {
			return err
		}
		if err := run("ip", "addr", "add", bridgeCIDR, "dev", bridgeName); err != nil {
			return err
		}
	}
	if err := run("ip", "link", "set", bridgeName, "up"); err != nil {
		return err
	}

	// Forwarding must be on or nothing leaves a sandbox. Set here rather than in
	// the image, because a node that reboots into a sysctl that did not apply is
	// a node whose apps have no egress and no obvious reason why.
	if err := run("sysctl", "-qw", "net.ipv4.ip_forward=1"); err != nil {
		return err
	}

	// Masquerade sandbox egress. The check-then-add is what makes this
	// idempotent; nft has no "add if absent" for a rule.
	if err := run("nft", "list", "table", "ip", "supersonic-nat"); err != nil {
		if err := run("nft", "add", "table", "ip", "supersonic-nat"); err != nil {
			return err
		}
		if err := run("nft", "add", "chain", "ip", "supersonic-nat", "postrouting",
			"{ type nat hook postrouting priority 100 ; }"); err != nil {
			return err
		}
		if err := run("nft", "add", "rule", "ip", "supersonic-nat", "postrouting",
			"ip", "saddr", "10.200.0.0/16", "oifname", "!=", bridgeName, "masquerade"); err != nil {
			return err
		}
	}
	return nil
}

// SandboxNet is what the rest of the agent needs to know about an app's network.
//
// Name and Path are both here because the two consumers want different things:
// `ip netns exec` takes the NAME, and the OCI spec's namespace entry takes the
// PATH. Handing the name to runsc gets `error opening "ss-<slug>": no such file
// or directory`, which reads like the namespace was never created rather than
// like it was named wrong.
type SandboxNet struct {
	Name string
	Path string
	IP   net.IP
}

// SetupSandboxNet builds the namespace, the veth pair, and the addressing for
// one app. `index` is the app's slot on this node and decides its address.
func SetupSandboxNet(slug string, index int) (*SandboxNet, error) {
	ns := netnsName(slug)
	host, peer := vethNames(slug)

	// 10.200.<index/254+1>.<index%254+1> — skips .0 and .255 in each octet so no
	// app can be handed a network or broadcast address.
	ip := net.IPv4(10, 200, byte(index/254+1), byte(index%254+1))

	// Tear down any remnant first. A half-built namespace from a killed agent is
	// the normal case after a crash, and "already exists" would otherwise make
	// the app unstartable until a human intervened.
	TeardownSandboxNet(slug)

	if err := run("ip", "netns", "add", ns); err != nil {
		return nil, fmt.Errorf("netns add: %w", err)
	}
	if err := run("ip", "link", "add", host, "type", "veth", "peer", "name", peer); err != nil {
		return nil, fmt.Errorf("veth add: %w", err)
	}
	if err := run("ip", "link", "set", host, "master", bridgeName, "up"); err != nil {
		return nil, fmt.Errorf("veth to bridge: %w", err)
	}
	if err := run("ip", "link", "set", peer, "netns", ns); err != nil {
		return nil, fmt.Errorf("peer to netns: %w", err)
	}

	inNS := func(args ...string) error {
		return run(append([]string{"ip", "netns", "exec", ns}, args...)...)
	}
	if err := inNS("ip", "addr", "add", fmt.Sprintf("%s/%d", ip, subnetMask), "dev", peer); err != nil {
		return nil, fmt.Errorf("addr: %w", err)
	}
	if err := inNS("ip", "link", "set", peer, "up"); err != nil {
		return nil, fmt.Errorf("peer up: %w", err)
	}
	if err := inNS("ip", "link", "set", "lo", "up"); err != nil {
		return nil, fmt.Errorf("lo up: %w", err)
	}
	if err := inNS("ip", "route", "add", "default", "via", "10.200.0.1"); err != nil {
		return nil, fmt.Errorf("default route: %w", err)
	}

	return &SandboxNet{Name: ns, Path: NetnsPath(slug), IP: ip}, nil
}

// TeardownSandboxNet removes everything SetupSandboxNet made. Deleting the
// namespace takes the peer veth with it; the host side is removed explicitly
// because it lives in the root namespace and would otherwise accumulate.
func TeardownSandboxNet(slug string) {
	host, _ := vethNames(slug)
	runOK("ip", "netns", "delete", netnsName(slug))
	runOK("ip", "link", "delete", host)
}

// NetnsPath is what goes into the OCI spec's network namespace entry.
func NetnsPath(slug string) string { return "/var/run/netns/" + netnsName(slug) }

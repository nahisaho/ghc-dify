// SPDX-License-Identifier: Apache-2.0
// Local bounded-output/process-lifecycle adaptation for dify-sandbox 0.2.15.
package runner

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type OutputCaptureRunner struct {
	stdout chan []byte
	stderr chan []byte
	done chan bool
	timeout time.Duration
	after_exit_hook func()
	uid int
	cancel context.CancelFunc
	ctx context.Context
}

func NewOutputCaptureRunner() *OutputCaptureRunner {
	return &OutputCaptureRunner{stdout: make(chan []byte), stderr: make(chan []byte), done: make(chan bool, 1)}
}
func (s *OutputCaptureRunner) SetJobUID(uid int) { s.uid = uid }
func (s *OutputCaptureRunner) SetAfterExitHook(hook func()) { s.after_exit_hook = hook }
func (s *OutputCaptureRunner) SetTimeout(timeout time.Duration) { s.timeout = timeout }
func (s *OutputCaptureRunner) GetStdout() chan []byte { return s.stdout }
func (s *OutputCaptureRunner) GetStderr() chan []byte { return s.stderr }
func (s *OutputCaptureRunner) GetDone() chan bool { return s.done }
func (s *OutputCaptureRunner) WriteError(data []byte) {
	select { case s.stderr <- append([]byte(nil), data...): case <-s.ctx.Done(): }
}
func (s *OutputCaptureRunner) WriteOutput(data []byte) {
	select { case s.stdout <- append([]byte(nil), data...): case <-s.ctx.Done(): }
}

func (s *OutputCaptureRunner) reap(cmd *exec.Cmd) {
	// A root pre-drop child can be signaled by its same-UID parent.
	// A post-drop job is signaled by a separate cap0 same-job-UID helper.
	_ = cmd.Process.Kill()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	helper := exec.CommandContext(ctx, "/usr/local/bin/python3", "/usr/local/lib/dify-image/kill_job.py", strconv.Itoa(s.uid))
	helper.Env = []string{}
	helper.Dir = "/"
	if helper.Run() != nil {
		// Never recycle the UID after uncertain cleanup. PID1 must shut down.
		os.Exit(71)
	}
}

func (s *OutputCaptureRunner) CaptureOutput(ctx context.Context, cmd *exec.Cmd) error {
	if s.uid < 10000 || s.uid >= 11000 { return errors.New("invalid sandbox lease") }
	timeout := s.timeout
	if timeout <= 0 { timeout = 5*time.Second }
	s.ctx, s.cancel = context.WithCancel(context.Background())
	out, err := cmd.StdoutPipe()
	if err != nil { s.cancel(); return err }
	errs, err := cmd.StderrPipe()
	if err != nil { out.Close(); s.cancel(); return err }
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err = cmd.Start(); err != nil {
		out.Close(); errs.Close(); s.cancel(); return err
	}
	var wg sync.WaitGroup
	wg.Add(2)
	read := func(reader io.ReadCloser, emit func([]byte)) {
		defer wg.Done()
		defer reader.Close()
		total := 0
		for {
			buffer := make([]byte, 4096)
			n, err := reader.Read(buffer)
			total += n
			if total > 1024*1024 { s.cancel(); return }
			if n > 0 { emit(buffer[:n]) }
			if err != nil { return }
		}
	}
	go read(out, s.WriteOutput)
	go read(errs, s.WriteError)
	exited := make(chan *os.ProcessState, 1)
	go func() { state, _ := cmd.Process.Wait(); exited <- state }()
	go func() {
		defer s.cancel()
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		var state *os.ProcessState
		timedOut := false
		select {
		case state = <-exited:
		case <-timer.C: timedOut = true
		case <-ctx.Done(): timedOut = true
		case <-s.ctx.Done(): timedOut = true
		}
		s.reap(cmd)
		if state == nil {
			select { case state = <-exited: case <-time.After(2*time.Second): os.Exit(72) }
		}
		drained := make(chan bool, 1)
		go func() { wg.Wait(); drained <- true }()
		select { case <-drained: case <-time.After(2*time.Second): os.Exit(73) }
		if timedOut { s.WriteError([]byte("error: timeout or output limit\n"))
		} else if state == nil || !state.Success() { s.WriteError([]byte("error: sandbox execution failed\n")) }
		if s.after_exit_hook != nil { s.after_exit_hook() }
		s.done <- true
	}()
	return nil
}

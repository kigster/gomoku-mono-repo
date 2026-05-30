# DTrace Investigation: High Kernel CPU Usage in gomoku-httpd

This document describes the investigation and resolution of high kernel-space CPU usage observed when running multiple `gomoku-httpd` instances.

## Problem Description

When running a swarm of `gomoku-httpd` servers, CPU usage was observed to be very high, particularly in kernel space (the "red zone" in htop). This occurred even when the servers were idle, waiting for requests.

## Investigation Process

### Initial Hypothesis

Based on code review of the httpserver.h library, several potential causes were identified:

1. SO_REUSEPORT socket option with single instances
1. Edge-triggered events with tight accept loop
1. Event loop busy-spinning due to zero timeout
1. Lack of connection limiting

### DTrace Limitations

On macOS with System Integrity Protection (SIP) enabled, direct syscall tracing via DTrace is restricted:

```
dtrace: system integrity protection is on, some features will not be available
dtrace: invalid probe specifier syscall:::entry does not match any probes
```

Alternative profiling was performed using the `sample` command:

```bash
sudo sample <PID> 5 -f /tmp/gomoku-sample.txt
```

### Root Cause Identification

The investigation revealed the root cause in `lib/httpserver.h/httpserver.h`:

**kqueue (macOS) - Lines 2348-2357:**

```c
int hs_server_poll_events(http_server_t *serv) {
  struct kevent ev;
  struct timespec ts = {0, 0};  // ZERO TIMEOUT - causes busy-spin!
  int nev = kevent(serv->loop, NULL, 0, &ev, 1, &ts);
  ...
}
```

**epoll (Linux) - Lines 2398-2406:**

```c
int hs_server_poll_events(http_server_t *serv) {
  struct epoll_event ev;
  int nev = epoll_wait(serv->loop, &ev, 1, 0);  // ZERO TIMEOUT!
  ...
}
```

The main event loop in `src/net/main.c` calls `http_server_poll()` in a while loop:

```c
while (running) {
    int poll_result = http_server_poll(server);
    if (poll_result < 0) {
        break;
    }
}
```

With a zero timeout, `kevent()` and `epoll_wait()` return immediately even when no events are available. This causes the loop to spin continuously, consuming 100% CPU.

## The Fix

Changed the timeout from zero to 100 milliseconds:

**kqueue fix:**

```c
struct timespec ts = {0, 100000000};  // 100ms timeout
```

**epoll fix:**

```c
int nev = epoll_wait(serv->loop, &ev, 1, 100);  // 100ms timeout
```

This allows the event loop to:

1. Block efficiently when no events are pending
1. Wake up promptly when new connections arrive
1. Check the `running` flag periodically for graceful shutdown (at most every 100ms)

## Results

### Before Fix

- Idle CPU usage: ~100% (busy-spin)
- Kernel CPU time: High (constant syscall overhead)

### After Fix

- Idle CPU usage: 0%
- Kernel CPU time: Minimal (only during actual I/O)
- Server responsiveness: Unchanged (100ms max latency for new connections)

## Verification

```bash
# Start daemon
./gomoku-httpd -b 127.0.0.1:8080 -d

# Monitor CPU (should show 0% when idle)
ps -p $(pgrep gomoku-httpd) -o %cpu,pid,comm

# Test functionality
./gomoku-http-client -p 8080 -d 3 -r 2
```

## Alternative Solutions Considered

1. **Using blocking event loop**: The httpserver.h library provides `hs_server_run_event_loop()` which uses blocking `kevent()` with a 1-second timer. However, this would require restructuring the graceful shutdown logic.

1. **Signal-based wakeup**: Using a self-pipe or eventfd to wake the event loop on SIGTERM. More complex but would allow truly blocking waits.

1. **nginx-style master/worker model**: Discussed as a potential future enhancement if socket binding issues arise with multiple instances. The current fix resolves the immediate CPU issue without requiring architectural changes.

## Lessons Learned

1. Always verify that event loop polling has appropriate timeouts
1. Zero-timeout polling is only appropriate when combined with sleep or other blocking mechanisms
1. System profiling tools like `sample` can identify issues even when DTrace is restricted by SIP
1. Code review of third-party libraries is essential for understanding performance characteristics

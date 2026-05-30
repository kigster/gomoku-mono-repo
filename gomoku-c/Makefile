# vim: ft=make
# vim: tabstop=8
# vim: shiftwidth=8
# vim: noexpandtab
#
# This Makefile handles C/C++ compilation only.
# For all other tasks (docker, deploy, evals, formatting, etc.) use: just --list

OS              := $(shell uname -s | tr '[:upper:]' '[:lower:]')

CC               	= gcc
CXX              	= g++
JSONC_DIR        	= src/vendor/json-c
JSONC_BUILD      	= $(JSONC_DIR)/build
JSONC_LIB        	= $(JSONC_BUILD)/libjson-c.a
CFLAGS           	= -Wall -Wunused-parameter -Wextra -Wno-gnu-folding-constant -Wimplicit-function-declaration -Wno-sign-compare -Isrc/gomoku -Isrc -I$(JSONC_BUILD) -I$(JSONC_DIR) -O3
# On macOS, Apple Clang may use an incomplete C++ include dir and miss standard headers
# (e.g. cstddef, cstdlib). Add the SDK's C++ include path when available.
MACOS_CXX_INCLUDE	= $(shell [ "$(OS)" = darwin ] && sdk=$$(xcrun --show-sdk-path 2>/dev/null) && [ -d "$$sdk/usr/include/c++/v1" ] && echo "-I$$sdk/usr/include/c++/v1")
_CXXFLAGS        	= -Wall -Wunused-parameter -Wextra -std=c++17 -Isrc/gomoku -Isrc -Itests/googletest/googletest/include -I$(JSONC_BUILD) -I$(JSONC_DIR) -Wimplicit-function-declaration -O2 $(MACOS_CXX_INCLUDE)
ALL_CXXFLAGS     	= $(_CXXFLAGS) $(CXXFLAGS)
LDFLAGS          	= -lm $(JSONC_LIB)

PACKAGE 		= gomoku
DAEMON_PACKAGE  	= gomoku-httpd
DAEMON_CLIENT  		= gomoku-http-client
BINDIR           	= bin

TARGET           	= $(BINDIR)/$(PACKAGE)
SOURCES          	= src/gomoku/main.c src/gomoku/gomoku.c src/gomoku/board.c src/gomoku/game.c src/gomoku/ai.c src/gomoku/ui.c src/gomoku/cli.c
OBJECTS          	= $(SOURCES:.c=.o)

# Daemon configuration
DAEMON_TARGET    	= $(BINDIR)/$(DAEMON_PACKAGE)
DAEMON_CORE      	= src/gomoku/gomoku.o src/gomoku/board.o src/gomoku/game.o src/gomoku/ai.o
DAEMON_NET       	= src/net/main.o src/net/cli.o src/net/handlers.o src/net/json_api.o src/net/logger.o
HTTPSERVER_DIR   	= src/vendor/httpserver
# Platform-specific flags for httpserver.h
ifeq ($(OS),darwin)
HTTPSERVER_PLATFORM 	= -DKQUEUE
else
HTTPSERVER_PLATFORM	= -DEPOLL
endif
# Test HTTP client
DAEMON_CLIENT_TARGET 	= $(BINDIR)/$(DAEMON_CLIENT)

DAEMON_CFLAGS    	= $(CFLAGS) -I$(HTTPSERVER_DIR) $(HTTPSERVER_PLATFORM)

DEFAULT_ALL		= $(TARGET) $(DAEMON_TARGET) $(DAEMON_CLIENT_TARGET)


TEST_HTTP_SRC    	= src/net/test_client.c src/net/test_client_utils.c

# Test configuration
TEST_TARGET     	= $(BINDIR)/test_gomoku
TEST_SOURCES    	= tests/gomoku_test.cpp src/gomoku.c src/board.c src/game.c src/ai.c
TEST_OBJECTS    	= $(TEST_SOURCES:.cpp=.o)
GTEST_LIB       	= tests/googletest/build/lib/libgtest.a
GTEST_MAIN_LIB  	= tests/googletest/build/lib/libgtest_main.a

FIND                    = /usr/bin/find

# Daemon test configuration
DAEMON_TEST_TARGET 	= $(BINDIR)/test_daemon
DAEMON_TEST_CXXFLAGS 	= $(ALL_CXXFLAGS)

# Gomocup brain configuration
#
# The brain links the engine without json-c; -DNO_JSON strips the JSON
# helpers in game.{c,h}. Engine objects are compiled to a separate
# .nojson.o suffix so the TUI and daemon (which DO need json-c) keep
# their own object files.
GOMOCUP_DIR        = src/gomocup
GOMOCUP_BIN        = $(BINDIR)/pbrain-kig-standard
GOMOCUP_CFLAGS     = -Wall -Wextra -Wno-sign-compare -O3 -Isrc/gomoku -I$(GOMOCUP_DIR) -DNO_JSON
GOMOCUP_CORE_OBJS  = src/gomoku/gomoku.nojson.o src/gomoku/board.nojson.o src/gomoku/game.nojson.o src/gomoku/ai.nojson.o
GOMOCUP_OBJS       = $(GOMOCUP_DIR)/main.o $(GOMOCUP_DIR)/protocol.o $(GOMOCUP_DIR)/coords.o $(GOMOCUP_DIR)/time_budget.o
GOMOCUP_TEST_TARGET= $(BINDIR)/test_gomocup
GOMOCUP_TEST_CXXFLAGS = -Wall -Wunused-parameter -Wextra -std=c++17 -I$(GOMOCUP_DIR) -Itests/googletest/googletest/include -O2 $(MACOS_CXX_INCLUDE)

.PHONY: all clean test tests rebuild json-c gomoku-httpd googletest test-client test-daemon gomocup pbrain-kig-standard test-gomocup-e2e gomocup-win pbrain-kig-standard-x86-64.exe pbrain-kig-standard-x86-32.exe gomocup-zip

$(BINDIR):
		@mkdir -p $(BINDIR)

docker-install: all
		cp -pv $(DEFAULT_ALL) ./bin


rebuild: 	clean all install

json-c: 	$(JSONC_LIB)

$(JSONC_LIB):
		@if [ ! -f $(JSONC_LIB) ]; then \
			echo "Building json-c library..."; \
			mkdir -p $(JSONC_BUILD); \
			LDFLAGS="" cmake -S $(JSONC_DIR) -B $(JSONC_BUILD) -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON; \
			LDFLAGS="" $(MAKE) -C $(JSONC_BUILD) -j4; \
		fi

$(TARGET): $(JSONC_LIB) $(OBJECTS) | $(BINDIR)
		$(CC) $(OBJECTS) $(LDFLAGS) -o $(TARGET)

# Daemon targets (must come before generic src/%.o rule). The file rule
# is keyed off $(DAEMON_TARGET) (= bin/gomoku-httpd) so `make all` —
# which depends on the path via $(DEFAULT_ALL) — can resolve it. The
# bare `gomoku-httpd` is kept as a phony alias for backwards compat.
$(DAEMON_TARGET): $(JSONC_LIB) $(DAEMON_CORE) $(DAEMON_NET) | $(BINDIR)
		$(CC) $(DAEMON_CORE) $(DAEMON_NET) $(LDFLAGS) -lpthread -o $(DAEMON_TARGET)

gomoku-httpd: $(DAEMON_TARGET)

src/net/%.o: src/net/%.c | $(JSONC_LIB)
		$(CC) $(DAEMON_CFLAGS) -c $< -o $@

# Build terminal gomoku and gomoku-httpd + test client

all: 		$(DEFAULT_ALL)

install: 	all
		cp -pv $(DEFAULT_ALL) ../bin

# HTTP test client
$(DAEMON_CLIENT_TARGET): $(TEST_HTTP_SRC) | $(BINDIR)
		$(CC) $(CFLAGS) $(TEST_HTTP_SRC) -o $(DAEMON_CLIENT_TARGET)

test-client: 	$(DAEMON_CLIENT_TARGET)

# Generic src rules (net rule must come before gomoku rule)
src/gomoku/%.o: src/gomoku/%.c | $(JSONC_LIB)
		$(CC) $(CFLAGS) -c $< -o $@

googletest:
		@bash -c "./tests/tests-setup"

$(TEST_TARGET): googletest $(JSONC_LIB) tests/gomoku_test.o src/gomoku/gomoku.o src/gomoku/board.o src/gomoku/game.o src/gomoku/ai.o | $(BINDIR)
		$(CXX) $(ALL_CXXFLAGS) tests/gomoku_test.o src/gomoku/gomoku.o src/gomoku/board.o src/gomoku/game.o src/gomoku/ai.o $(GTEST_LIB) $(GTEST_MAIN_LIB) $(JSONC_LIB) -pthread -o $(TEST_TARGET)

tests/gomoku_test.o: googletest tests/gomoku_test.cpp src/gomoku/gomoku.h src/gomoku/board.h src/gomoku/game.h src/gomoku/ai.h
		$(CXX) $(ALL_CXXFLAGS) -c tests/gomoku_test.cpp -o tests/gomoku_test.o

test: 		$(TEST_TARGET) $(DAEMON_TEST_TARGET) $(GOMOCUP_TEST_TARGET) $(TARGET) test-gomocup-e2e
		@echo "=== Running Game Tests ==="
		@./$(TEST_TARGET) | GREP_COLOR=32 grep --color=always -E 'GomokuTest\.([A-Za-z_]*)|tests|results|PASSED|FAILED'
		@echo ""
		@echo "=== Running Daemon Tests ==="
		@./$(DAEMON_TEST_TARGET) | GREP_COLOR=32 grep --color=always -E 'Daemon[A-Za-z]*Test\.([A-Za-z_]*)|tests|results|PASSED|FAILED'
		@echo ""
		@echo "=== Running Gomocup Tests ==="
		@./$(GOMOCUP_TEST_TARGET) | GREP_COLOR=32 grep --color=always -E 'Gomocup[A-Za-z]*Test\.([A-Za-z_]*)|tests|results|PASSED|FAILED'

# End-to-end scripted protocol session against the native brain. Builds
# the brain first if needed, then pipes a known scenario through it.
test-gomocup-e2e: $(GOMOCUP_BIN)
		@echo ""
		@echo "=== Running Gomocup Protocol E2E ==="
		@bash tests/gomocup_protocol_e2e.sh

tests: 		test

# Daemon tests
$(DAEMON_TEST_TARGET): googletest $(JSONC_LIB) tests/daemon_test.o $(DAEMON_CORE) src/net/cli.o src/net/json_api.o src/net/test_client_utils.o src/net/logger.o | $(BINDIR)
		$(CXX) $(ALL_CXXFLAGS) tests/daemon_test.o $(DAEMON_CORE) src/net/cli.o src/net/json_api.o src/net/test_client_utils.o src/net/logger.o $(GTEST_LIB) $(GTEST_MAIN_LIB) $(JSONC_LIB) -pthread -o $(DAEMON_TEST_TARGET)

tests/daemon_test.o: googletest tests/daemon_test.cpp src/net/cli.h src/net/json_api.h
		$(CXX) $(DAEMON_TEST_CXXFLAGS) -c tests/daemon_test.cpp -o tests/daemon_test.o

# Gomocup brain object compilation (separate from the engine's generic rule
# because the brain links against -DNO_JSON-built engine objects).
$(GOMOCUP_DIR)/%.o: $(GOMOCUP_DIR)/%.c
		$(CC) $(GOMOCUP_CFLAGS) -c $< -o $@

# Engine objects rebuilt with -DNO_JSON for the brain. Distinct .nojson.o
# suffix prevents collision with the TUI's plain .o files.
src/gomoku/%.nojson.o: src/gomoku/%.c
		$(CC) $(GOMOCUP_CFLAGS) -c $< -o $@

# Native brain target (macOS / Linux). Use this for development; the
# Windows tournament binaries are built via the gomocup-win target.
$(GOMOCUP_BIN): $(GOMOCUP_CORE_OBJS) $(GOMOCUP_OBJS) | $(BINDIR)
		$(CC) $(GOMOCUP_CORE_OBJS) $(GOMOCUP_OBJS) -lm -o $(GOMOCUP_BIN)

pbrain-kig-standard: $(GOMOCUP_BIN)

gomocup: $(GOMOCUP_BIN)

# Windows cross-build (mingw-w64 on macOS / Linux). The two .exe files are
# the actual tournament artefacts; native binaries above are for development
# only. Both are statically linked so the Gomocup judges can run them on a
# stock Windows install with no mingw runtime DLLs available.
WIN64_CC      = x86_64-w64-mingw32-gcc
WIN32_CC      = i686-w64-mingw32-gcc
WIN_CFLAGS    = -Wall -Wextra -Wno-sign-compare -O3 -Isrc/gomoku -I$(GOMOCUP_DIR) -DNO_JSON -static -static-libgcc

GOMOCUP_WIN64_DIR = $(GOMOCUP_DIR)/win64
GOMOCUP_WIN32_DIR = $(GOMOCUP_DIR)/win32

# All sources we need to compile into per-target object directories.
GOMOCUP_WIN_SRCS  = src/gomoku/gomoku.c src/gomoku/board.c src/gomoku/game.c src/gomoku/ai.c \
                    $(GOMOCUP_DIR)/main.c $(GOMOCUP_DIR)/protocol.c $(GOMOCUP_DIR)/coords.c $(GOMOCUP_DIR)/time_budget.c

$(BINDIR)/pbrain-kig-standard-x86-64.exe: $(GOMOCUP_WIN_SRCS) | $(BINDIR)
		$(WIN64_CC) $(WIN_CFLAGS) $(GOMOCUP_WIN_SRCS) -o $@

$(BINDIR)/pbrain-kig-standard-x86-32.exe: $(GOMOCUP_WIN_SRCS) | $(BINDIR)
		$(WIN32_CC) $(WIN_CFLAGS) -m32 $(GOMOCUP_WIN_SRCS) -o $@

pbrain-kig-standard-x86-64.exe: $(BINDIR)/pbrain-kig-standard-x86-64.exe
pbrain-kig-standard-x86-32.exe: $(BINDIR)/pbrain-kig-standard-x86-32.exe

gomocup-win: $(BINDIR)/pbrain-kig-standard-x86-64.exe $(BINDIR)/pbrain-kig-standard-x86-32.exe

# Submission zip. Per plan §10, the archive contains both .exe files plus a
# README.txt stamped with git SHA + build timestamp. The zip is shallow
# (-j) so the .exe files land at the archive root, which is what Piskvork
# expects when it scans for brain executables.
gomocup-zip: gomocup-win
		@echo "Generating bin/README.txt with build provenance..."
		@printf 'pbrain-kig-standard\n' > $(BINDIR)/README.txt
		@printf 'Author : Konstantin Gredeskoul <kigster@gmail.com>\n' >> $(BINDIR)/README.txt
		@printf 'WWW    : https://kig.re\n' >> $(BINDIR)/README.txt
		@printf 'Version: 1.0.0\n' >> $(BINDIR)/README.txt
		@printf 'Git SHA: %s\n' "$$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >> $(BINDIR)/README.txt
		@printf 'Built  : %s\n' "$$(date -u +'%Y-%m-%dT%H:%M:%SZ')" >> $(BINDIR)/README.txt
		@printf '\nFiles:\n' >> $(BINDIR)/README.txt
		@printf '  pbrain-kig-standard-x86-64.exe Win64 brain (filename with "64" per Gomocup rule)\n' >> $(BINDIR)/README.txt
		@printf '  pbrain-kig-standard-x86-32.exe Win32 brain\n' >> $(BINDIR)/README.txt
		rm -f   $(BINDIR)/pbrain-kig-standard.zip
		zip -j  $(BINDIR)/pbrain-kig-standard.zip \
			$(BINDIR)/pbrain-kig-standard-x86-64.exe \
			$(BINDIR)/pbrain-kig-standard-x86-32.exe \
			$(BINDIR)/README.txt
		@echo ""
		@echo "Submission archive ready: $(BINDIR)/pbrain-kig-standard.zip"
		@ls -la $(BINDIR)/pbrain-kig-standard.zip

# Gomocup brain unit tests
$(GOMOCUP_TEST_TARGET): googletest tests/gomocup_test.o $(GOMOCUP_DIR)/protocol.o $(GOMOCUP_DIR)/coords.o | $(BINDIR)
		$(CXX) $(GOMOCUP_TEST_CXXFLAGS) tests/gomocup_test.o $(GOMOCUP_DIR)/protocol.o $(GOMOCUP_DIR)/coords.o $(GTEST_LIB) $(GTEST_MAIN_LIB) -pthread -o $(GOMOCUP_TEST_TARGET)

tests/gomocup_test.o: googletest tests/gomocup_test.cpp $(GOMOCUP_DIR)/protocol.h $(GOMOCUP_DIR)/coords.h
		$(CXX) $(GOMOCUP_TEST_CXXFLAGS) -c tests/gomocup_test.cpp -o tests/gomocup_test.o

test-daemon: 	$(DAEMON_TEST_TARGET)
		./$(DAEMON_TEST_TARGET) | GREP_COLOR=32 grep --color=always -E 'Daemon[A-Za-z]*Test\.([A-Za-z_]*)|tests|results|PASSED|FAILED'

clean:
		rm -rf $(BINDIR)
		rm -f $(OBJECTS) tests/gomoku_test.o
		rm -f $(DAEMON_CORE) $(DAEMON_NET) src/net/test_client_utils.o tests/daemon_test.o
		rm -f $(GOMOCUP_OBJS) $(GOMOCUP_CORE_OBJS) tests/gomocup_test.o
		rm -rf tests/googletest
		$(FIND) . -name '*.a' -type f -delete || true
		$(FIND) . -name '.DS_Store' -type f -delete || true

format:
		$(FIND) src/gomoku src/net -maxdepth 3 -name '*.c**' | xargs clang-format -i
		$(FIND) tests -maxdepth 3 -name '*.c**' | xargs clang-format -i


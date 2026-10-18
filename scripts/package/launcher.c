// The program of Tutor.app. It starts the tutor server in the background, and then it ends.
// The server opens the browser. If a tutor runs already, the server only opens the browser.
// The output of the server goes to ~/Library/Logs/Tutor.log.
// Apple expects a compiled program as the main program of an app, so this file is C and not a shell script.

#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/xattr.h>

extern char **environ;

// Remove the last part of a path.
static int up(char *path) {
  char *slash = strrchr(path, '/');
  if (!slash) return -1;
  *slash = '\0';
  return 0;
}

int main(void) {
  char path[PATH_MAX], contents[PATH_MAX], app[PATH_MAX];
  uint32_t size = sizeof path;
  if (_NSGetExecutablePath(path, &size) != 0 || !realpath(path, contents)) return 1;
  // The path is .../Tutor.app/Contents/MacOS/Tutor. Two steps up give .../Tutor.app/Contents.
  if (up(contents) != 0 || up(contents) != 0) return 1;
  snprintf(app, sizeof app, "%s", contents);
  if (up(app) != 0) return 1;

  char node[PATH_MAX], server[PATH_MAX], logs[PATH_MAX], log[PATH_MAX];
  snprintf(node, sizeof node, "%s/MacOS/node", contents);
  snprintf(server, sizeof server, "%s/Resources/app/dist/server/main.js", contents);

  posix_spawn_file_actions_t quiet;
  posix_spawn_file_actions_init(&quiet);
  posix_spawn_file_actions_addopen(&quiet, 1, "/dev/null", O_WRONLY, 0);
  posix_spawn_file_actions_addopen(&quiet, 2, "/dev/null", O_WRONLY, 0);
  pid_t pid;

  // A download marks each file of the app as quarantined. Then macOS can block the native files of the packages.
  // The user opened the app, so the marks can go. A signed app does not need this step, but the step does no harm.
  if (getxattr(app, "com.apple.quarantine", NULL, 0, 0, 0) >= 0) {
    char *xattr[] = {"/usr/bin/xattr", "-dr", "com.apple.quarantine", app, NULL};
    if (posix_spawn(&pid, xattr[0], &quiet, NULL, xattr, environ) == 0) waitpid(pid, NULL, 0);
  }

  const char *home = getenv("HOME");
  if (!home) return 1;
  snprintf(logs, sizeof logs, "%s/Library", home);
  mkdir(logs, 0700);
  snprintf(logs, sizeof logs, "%s/Library/Logs", home);
  mkdir(logs, 0700);
  snprintf(log, sizeof log, "%s/Tutor.log", logs);

  posix_spawn_file_actions_t files;
  posix_spawn_file_actions_init(&files);
  posix_spawn_file_actions_addopen(&files, 0, "/dev/null", O_RDONLY, 0);
  posix_spawn_file_actions_addopen(&files, 1, log, O_WRONLY | O_CREAT | O_APPEND, 0600);
  posix_spawn_file_actions_adddup2(&files, 1, 2);
  // The server runs in its own session, so it continues after this program ends.
  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSID);
  char *args[] = {node, server, "--app", NULL};
  return posix_spawn(&pid, node, &files, &attributes, args, environ) == 0 ? 0 : 1;
}

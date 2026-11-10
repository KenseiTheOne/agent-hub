// Minimal HTTP client over a Unix socket for app-class tests:
//   client <socket> <METHOD> <path> [json-body]
// Prints the server's whole response. The test builds it with clang and signs it ad hoc.
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 4) return 64;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un a = {0};
  a.sun_family = AF_UNIX;
  strncpy(a.sun_path, argv[1], sizeof(a.sun_path) - 1);
  if (connect(fd, (struct sockaddr *)&a, sizeof(a)) != 0) return 2;
  const char *body = argc > 4 ? argv[4] : "";
  char req[8192];
  int n = snprintf(req, sizeof(req),
                   "%s %s HTTP/1.1\r\nHost: hub\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n%s",
                   argv[2], argv[3], strlen(body), body);
  if (write(fd, req, (size_t)n) != n) return 3;
  char buf[65536];
  ssize_t r;
  while ((r = read(fd, buf, sizeof(buf))) > 0) fwrite(buf, 1, (size_t)r, stdout);
  close(fd);
  return 0;
}

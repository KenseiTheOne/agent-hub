// peercred — an N-API addon: who is on the other end of a Unix socket (macOS).
//
// Exports:
//   peerPid(fd)            → pid of the process that connected (LOCAL_PEERPID)
//   peerUid(fd)            → peer uid (getpeereid)
//   pidPath(pid)           → executable path (proc_pidpath) or null
//   pidInfo(pid)           → { pid, ppid, pgid, uid, startSec, startUsec, comm, tty } or null (PROC_PIDTBSDINFO);
//                            tty — whether the process has a controlling terminal (PROC_FLAG_CONTROLT and e_tdev)
//   procArgv(pid)          → argv array (KERN_PROCARGS2) or null. The process environment,
//                            located in the same buffer after argv, is NOT parsed or returned.
//   getXattr(path, name)   → xattr value string or null
//   codeInfo(pid)          → { flags, cdhash, identity, teamId } from the kernel (csops) or null. The kernel keeps the signature
//                            of a running process in memory: the info is available even if the version's file was already deleted.
//
// Build: scripts/build-native.sh (clang from Command Line Tools, headers of the installed node, no node-gyp).

#define NAPI_VERSION 8
#include <node_api.h>

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <libproc.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/xattr.h>
#include <unistd.h>

#define CHECK(call)                                                          \
  do {                                                                       \
    if ((call) != napi_ok) {                                                 \
      napi_throw_error(env, NULL, "peercred: N-API call failed: " #call);    \
      return NULL;                                                           \
    }                                                                        \
  } while (0)

static int arg_int(napi_env env, napi_callback_info info, int32_t *out) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) return -1;
  if (napi_get_value_int32(env, argv[0], out) != napi_ok) return -1;
  return 0;
}

static napi_value js_null(napi_env env) {
  napi_value v;
  napi_get_null(env, &v);
  return v;
}

static napi_value PeerPid(napi_env env, napi_callback_info info) {
  int32_t fd;
  if (arg_int(env, info, &fd) != 0) {
    napi_throw_type_error(env, NULL, "peerPid(fd): fd must be an integer");
    return NULL;
  }
  pid_t pid = 0;
  socklen_t len = sizeof(pid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) != 0) return js_null(env);
  napi_value out;
  CHECK(napi_create_int32(env, pid, &out));
  return out;
}

static napi_value PeerUid(napi_env env, napi_callback_info info) {
  int32_t fd;
  if (arg_int(env, info, &fd) != 0) {
    napi_throw_type_error(env, NULL, "peerUid(fd): fd must be an integer");
    return NULL;
  }
  uid_t uid;
  gid_t gid;
  if (getpeereid(fd, &uid, &gid) != 0) return js_null(env);
  napi_value out;
  CHECK(napi_create_uint32(env, uid, &out));
  return out;
}

static napi_value PidPath(napi_env env, napi_callback_info info) {
  int32_t pid;
  if (arg_int(env, info, &pid) != 0) {
    napi_throw_type_error(env, NULL, "pidPath(pid): pid must be an integer");
    return NULL;
  }
  char buf[PROC_PIDPATHINFO_MAXSIZE];
  int n = proc_pidpath(pid, buf, sizeof(buf));
  if (n <= 0) return js_null(env);
  napi_value out;
  CHECK(napi_create_string_utf8(env, buf, (size_t)n, &out));
  return out;
}

static napi_value PidInfo(napi_env env, napi_callback_info info) {
  int32_t pid;
  if (arg_int(env, info, &pid) != 0) {
    napi_throw_type_error(env, NULL, "pidInfo(pid): pid must be an integer");
    return NULL;
  }
  struct proc_bsdinfo bi;
  int n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, sizeof(bi));
  if (n != (int)sizeof(bi)) return js_null(env);
  napi_value obj, v;
  CHECK(napi_create_object(env, &obj));
  CHECK(napi_create_int32(env, (int32_t)bi.pbi_pid, &v));
  CHECK(napi_set_named_property(env, obj, "pid", v));
  CHECK(napi_create_int32(env, (int32_t)bi.pbi_ppid, &v));
  CHECK(napi_set_named_property(env, obj, "ppid", v));
  CHECK(napi_create_int32(env, (int32_t)bi.pbi_pgid, &v));
  CHECK(napi_set_named_property(env, obj, "pgid", v));
  CHECK(napi_create_uint32(env, bi.pbi_uid, &v));
  CHECK(napi_set_named_property(env, obj, "uid", v));
  CHECK(napi_create_double(env, (double)bi.pbi_start_tvsec, &v));
  CHECK(napi_set_named_property(env, obj, "startSec", v));
  CHECK(napi_create_double(env, (double)bi.pbi_start_tvusec, &v));
  CHECK(napi_set_named_property(env, obj, "startUsec", v));
  size_t clen = strnlen(bi.pbi_comm, sizeof(bi.pbi_comm));
  CHECK(napi_create_string_utf8(env, bi.pbi_comm, clen, &v));
  CHECK(napi_set_named_property(env, obj, "comm", v));
  int tty = (bi.pbi_flags & PROC_FLAG_CONTROLT) && bi.e_tdev != (uint32_t)-1 && bi.e_tdev != 0;
  CHECK(napi_get_boolean(env, tty, &v));
  CHECK(napi_set_named_property(env, obj, "tty", v));
  return obj;
}

static napi_value ProcArgv(napi_env env, napi_callback_info info) {
  int32_t pid;
  if (arg_int(env, info, &pid) != 0) {
    napi_throw_type_error(env, NULL, "procArgv(pid): pid must be an integer");
    return NULL;
  }
  int argmax = 0;
  size_t size = sizeof(argmax);
  int mib_max[2] = {CTL_KERN, KERN_ARGMAX};
  if (sysctl(mib_max, 2, &argmax, &size, NULL, 0) != 0 || argmax <= 0) return js_null(env);
  char *buf = malloc((size_t)argmax);
  if (!buf) return js_null(env);
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size = (size_t)argmax;
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0 || size < sizeof(int)) {
    free(buf);
    return js_null(env);
  }
  int argc;
  memcpy(&argc, buf, sizeof(argc));
  char *p = buf + sizeof(argc);
  char *end = buf + size;
  // exec path, then padding zeros
  while (p < end && *p) p++;
  while (p < end && !*p) p++;
  napi_value arr;
  if (napi_create_array(env, &arr) != napi_ok) {
    free(buf);
    return NULL;
  }
  // Take exactly argc strings; leave everything after them (the environment) alone.
  for (int i = 0; i < argc && p < end; i++) {
    size_t len = strnlen(p, (size_t)(end - p));
    napi_value s;
    if (napi_create_string_utf8(env, p, len, &s) != napi_ok ||
        napi_set_element(env, arr, (uint32_t)i, s) != napi_ok) {
      free(buf);
      return NULL;
    }
    p += len + 1;
  }
  free(buf);
  return arr;
}

static napi_value GetXattr(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 2) {
    napi_throw_type_error(env, NULL, "getXattr(path, name)");
    return NULL;
  }
  char path[4096], name[256];
  size_t plen, nlen;
  CHECK(napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &plen));
  CHECK(napi_get_value_string_utf8(env, argv[1], name, sizeof(name), &nlen));
  ssize_t n = getxattr(path, name, NULL, 0, 0, 0);
  if (n < 0 || n > 1024 * 1024) return js_null(env);
  char *buf = malloc((size_t)n + 1);
  if (!buf) return js_null(env);
  n = getxattr(path, name, buf, (size_t)n, 0, 0);
  if (n < 0) {
    free(buf);
    return js_null(env);
  }
  napi_value out;
  napi_status st = napi_create_string_utf8(env, buf, (size_t)n, &out);
  free(buf);
  if (st != napi_ok) return js_null(env);
  return out;
}

// csops is a libsystem_kernel system call; the public SDK headers don't declare it.
extern int csops(pid_t pid, unsigned int ops, void *useraddr, size_t usersize);
#define AH_CS_OPS_STATUS 0
#define AH_CS_OPS_CDHASH 5
#define AH_CS_OPS_IDENTITY 11
#define AH_CS_OPS_TEAMID 14

static int cs_blob_string(pid_t pid, unsigned int op, char *out, size_t outlen) {
  struct {
    uint32_t magic;
    uint32_t len;
    char data[512];
  } blob;
  memset(&blob, 0, sizeof(blob));
  if (csops(pid, op, &blob, sizeof(blob)) != 0) return -1;
  size_t n = strnlen(blob.data, sizeof(blob.data));
  if (n >= outlen) n = outlen - 1;
  memcpy(out, blob.data, n);
  out[n] = 0;
  return 0;
}

static napi_value CodeInfo(napi_env env, napi_callback_info info) {
  int32_t pid;
  if (arg_int(env, info, &pid) != 0) {
    napi_throw_type_error(env, NULL, "codeInfo(pid): pid must be an integer");
    return NULL;
  }
  uint32_t flags = 0;
  if (csops(pid, AH_CS_OPS_STATUS, &flags, sizeof(flags)) != 0) return js_null(env);
  unsigned char hash[20];
  memset(hash, 0, sizeof(hash));
  if (csops(pid, AH_CS_OPS_CDHASH, hash, sizeof(hash)) != 0) return js_null(env);
  char hex[41];
  for (int i = 0; i < 20; i++) snprintf(hex + i * 2, 3, "%02x", hash[i]);
  char ident[256] = "", team[64] = "";
  int hasIdent = cs_blob_string(pid, AH_CS_OPS_IDENTITY, ident, sizeof(ident)) == 0;
  int hasTeam = cs_blob_string(pid, AH_CS_OPS_TEAMID, team, sizeof(team)) == 0;
  napi_value obj, v;
  CHECK(napi_create_object(env, &obj));
  CHECK(napi_create_uint32(env, flags, &v));
  CHECK(napi_set_named_property(env, obj, "flags", v));
  CHECK(napi_create_string_utf8(env, hex, 40, &v));
  CHECK(napi_set_named_property(env, obj, "cdhash", v));
  if (hasIdent) CHECK(napi_create_string_utf8(env, ident, NAPI_AUTO_LENGTH, &v));
  else v = js_null(env);
  CHECK(napi_set_named_property(env, obj, "identity", v));
  if (hasTeam) CHECK(napi_create_string_utf8(env, team, NAPI_AUTO_LENGTH, &v));
  else v = js_null(env);
  CHECK(napi_set_named_property(env, obj, "teamId", v));
  return obj;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"peerPid", NULL, PeerPid, NULL, NULL, NULL, napi_enumerable, NULL},
      {"peerUid", NULL, PeerUid, NULL, NULL, NULL, napi_enumerable, NULL},
      {"pidPath", NULL, PidPath, NULL, NULL, NULL, napi_enumerable, NULL},
      {"pidInfo", NULL, PidInfo, NULL, NULL, NULL, napi_enumerable, NULL},
      {"procArgv", NULL, ProcArgv, NULL, NULL, NULL, napi_enumerable, NULL},
      {"getXattr", NULL, GetXattr, NULL, NULL, NULL, napi_enumerable, NULL},
      {"codeInfo", NULL, CodeInfo, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props) != napi_ok) return NULL;
  return exports;
}

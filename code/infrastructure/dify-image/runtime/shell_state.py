"""Private shell lease recovery; never touches bootstrap seals or service secrets."""
import os
import shutil
import stat
import uuid
from pathlib import Path

from common import IDS

UID = 10900
HOME = Path("/data/shellctl/home")
ROOTS = Path("/run/dify/shell-roots")


class UnsafeState(RuntimeError):
    """A cleanup/ownership invariant is uncertain: never reuse this lease."""


def directory(path, owners, mode=None, *, private=True):
    """Validate the final component without following it; callers own its parent."""
    metadata = path.lstat()
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid not in owners
            or (private and metadata.st_mode & 0o022) or (mode is not None
                                          and stat.S_IMODE(metadata.st_mode) != mode)):
        raise UnsafeState("Invalid private directory")
    return metadata


def ownership(path, uid, group, *, owners=(0, UID, IDS["shellctl"])):
    """Walk only stopped, private trees via nofollow directory FDs.

    Ephemeral FIFOs/sockets are discarded, not copied or opened. Symlinks are
    lchowned, never traversed. No operation here is valid on cp-al template trees.
    """
    path = Path(path)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def visit(name, parent_fd):
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if metadata.st_uid not in owners:
            raise UnsafeState("Foreign workspace owner")
        if stat.S_ISLNK(metadata.st_mode):
            os.chown(name, uid, group, dir_fd=parent_fd, follow_symlinks=False)
            return
        if not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
            if not (stat.S_ISFIFO(metadata.st_mode) or stat.S_ISSOCK(metadata.st_mode)):
                raise UnsafeState("Unexpected workspace device")
            os.unlink(name, dir_fd=parent_fd)
            return
        os.chown(name, 0, 0, dir_fd=parent_fd, follow_symlinks=False)
        os.chmod(name, 0o700 if stat.S_ISDIR(metadata.st_mode)
                 else 0o600 | (metadata.st_mode & 0o100),
                 dir_fd=parent_fd, follow_symlinks=False)
        if stat.S_ISDIR(metadata.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=parent_fd)
            try:
                opened = os.fstat(child)
                if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
                    raise UnsafeState("Workspace identity changed")
                for entry in os.listdir(child):
                    visit(entry, child)
            finally:
                os.close(child)
        os.chown(name, uid, group, dir_fd=parent_fd, follow_symlinks=False)

    try:
        visit(path.name, parent)
    finally:
        os.close(parent)


def erase_home(path):
    """Discard a validated uncommitted/retired home, not an arbitrary /data path."""
    if path not in (HOME.with_name("home.next"), HOME.with_name("home.previous")):
        raise UnsafeState("Unrecognized home transaction path")
    directory(path, (0, IDS["shellctl"]), 0o700)
    ownership(path, 0, 0, owners=(0, IDS["shellctl"]))
    shutil.rmtree(path)


def recover_home():
    """Old home stays authoritative until next->home; replay only known states."""
    directory(HOME.parent, (0,), 0o750)
    previous, updated = HOME.with_name("home.previous"), HOME.with_name("home.next")
    present = {path: os.path.lexists(path) for path in (HOME, previous, updated)}
    for path, exists in present.items():
        if exists:
            directory(path, (0, IDS["shellctl"]), 0o700)
    if not present[HOME]:
        if not present[previous]:
            raise UnsafeState("Missing committed home")
        # A partial next copy is never promoted, including legacy orphan copies.
        previous.rename(HOME)
    ownership(HOME, IDS["shellctl"], IDS["shellctl"], owners=(0, IDS["shellctl"]))
    if present[updated]:
        erase_home(updated)
    if os.path.lexists(previous):
        erase_home(previous)


def sync_tree(path):
    """Make copied regular contents durable before committing directory names."""
    for parent, _, names in os.walk(path, followlinks=False):
        for name in names:
            child = Path(parent) / name
            if child.is_symlink():
                continue
            fd = os.open(child, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def commit_home(workspace):
    """Copy, fsync, rename old aside, install new, fsync parent, retire old."""
    previous, updated = HOME.with_name("home.previous"), HOME.with_name("home.next")
    if os.path.lexists(previous) or os.path.lexists(updated):
        raise UnsafeState("Unrecovered home transaction")
    shutil.copytree(workspace, updated, symlinks=True)
    sync_tree(updated)
    ownership(updated, IDS["shellctl"], IDS["shellctl"])
    HOME.rename(previous)
    updated.rename(HOME)
    fd = os.open(HOME.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    erase_home(previous)


def erase_root(root):
    """Only registered root-owned UUID directories beneath the private registry."""
    directory(ROOTS, (0,), 0o700)
    try:
        canonical = str(uuid.UUID(root.name))
    except ValueError as error:
        raise UnsafeState("Unrecognized private root") from error
    if root.parent != ROOTS or canonical != root.name:
        raise UnsafeState("Unrecognized private root")
    metadata = directory(root, (0,))
    if metadata.st_dev != ROOTS.lstat().st_dev:
        raise UnsafeState("Unexpected private-root filesystem")
    # Never normalize shared public hardlinks. Only these private mutable trees
    # may have job ownership; validate their fixed parent without following it.
    if os.path.lexists(root / "home"):
        directory(root / "home", (0,))
    for path in (root / "home/dify", root / "tmp"):
        if os.path.lexists(path):
            directory(path, (0, UID), private=False)
            ownership(path, 0, 0, owners=(0, UID))
    shutil.rmtree(root)


def recover_roots():
    """After clean_uid(), stale /run trees are disposable, unlike /data seals."""
    directory(ROOTS.parent, (0,))
    ROOTS.mkdir(mode=0o700, exist_ok=True)
    directory(ROOTS, (0,), 0o700)
    for root in ROOTS.iterdir():
        erase_root(root)

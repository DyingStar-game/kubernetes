'use strict';

/**
 * The only place the panel knows which OS it is running on.
 *
 * Everything else -- the whole UI, the start chain, the k8s actions, the log bus -- is portable:
 * docker, k3d and kubectl are the same binaries everywhere, and
 * GODOT_EDITOR_CUSTOM_FEATURES is a Godot mechanism, not a Windows one. Only a handful of
 * operations genuinely differ, and they all live behind this module:
 *
 *   killTree            kill a process and its descendants
 *   portInfo            who listens on a TCP port, and how many links are established
 *   reapOrphanGodot     headless Godot servers left holding the game-server port
 *   startDockerEngine   bring the Docker daemon up
 *   repoScriptCommand   how to run one of the kubernetes repository's scripts
 *                       (scripts_windows/*.ps1 or scripts_linux/*.sh), and its named shortcuts:
 *                       stackStartCommand, stackStopCommand, exposeHorizonCommand,
 *                       buildAndDeployCommand, checkDevCommand
 *   processCpuSeconds   CPU consumed by a pid -- the only way to tell a live process from a wedged one
 *   processStartTime    when a pid was created -- tells a live port-forward from one into a dead pod
 *
 * Adding a platform means adding one file here, not forking the tool.
 */

const impl = process.platform === 'win32'
  ? require('./win32')
  : require('./linux');   // Linux is the tested target; other POSIX systems share it

module.exports = impl;

// @flow
import Store from 'electron-store';
import type { spawn, ChildProcess } from 'child_process';
import type { WriteStream } from 'fs';
import type { CardanoNodeState, TlsConfig } from '../../common/types/cardanoNode.types';
import { promisedCondition, portIsTaken, processIsRunning, request } from './utils';
import { CardanoNodeStates } from '../../common/types/cardanoNode.types';

type Logger = {
  debug: (string) => void,
  info: (string) => void,
  error: (string) => void,
};

type Actions = {
  spawn: spawn,
  readFileSync: (path: string) => Buffer,
  createWriteStream: (path: string, options?: Object) => WriteStream,
  broadcastTlsConfig: (TlsConfig) => void,
  broadcastStateChange: (state: CardanoNodeState) => void,
};

type StateTransitions = {
  onStarting: () => void,
  onRunning: () => void,
  onStopping: () => void,
  onStopped: () => void,
  onUpdating: () => void,
  onUpdated: () => void,
  onCrashed: (code: number, signal: string) => void,
  onError: (error: Error) => void,
}

type CardanoNodeIpcMessage = {
  Started?: Array<any>,
  ReplyPort?: number,
}

type NodeArgs = Array<string>;

export type CardanoNodeConfig = {
  nodePath: string, // Path to cardano-node executable
  logFilePath: string, // Log file path for cardano-sl
  tlsPath: string, // Path to cardano-node TLS folder
  nodeArgs: NodeArgs, // Arguments that are used to spwan cardano-node
  startupTimeout: number, // Milliseconds to wait for cardano-node to startup
  startupMaxRetries: number, // Maximum number of retries for re-starting then ode
  shutdownTimeout: number, // Milliseconds to wait for cardano-node to gracefully shutdown
  killTimeout: number, // Milliseconds to wait for cardano-node to be killed
  updateTimeout: number, // Milliseconds to wait for cardano-node to update itself
};

// store for persisting CardanoNode data
const PREVIOUS_PORT = 'PREVIOUS_PORT';
const PREVIOUS_PID = 'PREVIOUS_PID';
const store = new Store();

export class CardanoNode {
  /**
   * The config used to spawn cardano-node
   * @private
   */
  _config: CardanoNodeConfig;
  /**
   * The managed cardano-node child process
   * @private
   */
  _node: ?ChildProcess;

  /**
   * The ipc channel used for broadcasting messages to the outside world
   * @private
   */
  _actions: Actions;

  /**
   * The ipc channel used for broadcasting messages to the outside world
   * @private
   */
  _transitionListeners: StateTransitions;

  /**
   * Logger instance to print debug messages to
   * @private
   */
  _log: Logger;

  /**
   * Log file stream for cardano-sl
   * @private
   */
  _cardanoLogFile: WriteStream;

  /**
   * The TLS config that is generated by the cardano-node
   * on each startup and is broadcasted over ipc channel
   * @private
   */
  _tlsConfig: ?TlsConfig = null;

  /**
   * The current state of the node, used for making decisions
   * when events like process crashes happen.
   * @type {CardanoNodeState}
   * @private
   */
  _state: CardanoNodeState = CardanoNodeStates.STOPPED;

  /**
   * Number of retries to startup the node (without ever reaching running state)
   */
  _startupTries: number = 0;

  /**
   * Getter which copies and returns the internal tls config.
   * @returns {TlsConfig}
   */
  get tlsConfig(): TlsConfig {
    return Object.assign({}, this._tlsConfig);
  }

  /**
   * Getter which returns the PID of the child process of cardano-node
   * @returns {TlsConfig} // I think this returns a number...
   */
  get pid(): ?number {
    return this._node ? this._node.pid : null;
  }

  /**
   * Getter for the current internal state of the node.
   * @returns {CardanoNodeState}
   */
  get state(): CardanoNodeState {
    return this._state;
  }

  /**
   * Constructs and prepares the CardanoNode instance for life.
   * @param log
   * @param actions
   * @param transitions
   */
  constructor(log: Logger, actions: Actions, transitions: StateTransitions) {
    this._log = log;
    this._actions = actions;
    this._transitionListeners = transitions;
    this._resetTlsConfig();
  }

  /**
   * Starts cardano-node as child process with given config and log file stream.
   * Waits up to `startupTimeout` for the process to connect.
   * Registers ipc listeners for any necessary process lifecycle events.
   * Asks the node to reply with the current port.
   * Transitions into STARTING state.
   *
   * @param config
   * @returns {Promise<void>} resolves if the node could be started, rejects with error otherwise.
   */
  start = async (config: CardanoNodeConfig): Promise<void> => {
    // Guards
    const nodeCanBeStarted = await this._canBeStarted(config.tlsPath);

    if (!nodeCanBeStarted) {
      return Promise.reject('CardanoNode: Cannot be started.');
    }
    if (this._startupTries >= config.startupMaxRetries) {
      return Promise.reject('CardanoNode: Too many startup retries.');
    }
    // Setup
    const { _log } = this;
    const { nodePath, nodeArgs, startupTimeout } = config;
    const { createWriteStream } = this._actions;
    this._config = config;

    _log.info(`CardanoNode: trying to start cardano-node for the ${this._startupTries}. time.`);
    this._startupTries++;
    this._changeToState(CardanoNodeStates.STARTING);

    return new Promise((resolve, reject) => {
      const logFile = createWriteStream(config.logFilePath, { flags: 'a' });
      logFile.on('open', async () => {
        this._cardanoLogFile = logFile;
        // Spawning cardano-node
        const jsonArgs = JSON.stringify(nodeArgs);
        _log.debug(`from path: ${nodePath} with args: ${jsonArgs}.`);
        const node = this._spawnNode(nodePath, nodeArgs, logFile);
        this._node = node;
        try {
          await promisedCondition(() => node.connected, startupTimeout);
          // Setup livecycle event handlers
          node.on('message', this._handleCardanoNodeMessage);
          node.on('exit', this._handleCardanoNodeExit);
          node.on('error', this._handleCardanoNodeError);
          // Request cardano-node to reply with port
          node.send({ QueryPort: [] });
          _log.info(`CardanoNode: cardano-node child process spawned with PID ${node.pid}`);
          resolve();
        } catch (_) {
          reject('CardanoNode: Error while spawning cardano-node.');
        }
      });
    });
  };

  /**
   * Stops cardano-node, first by disconnecting and waiting up to `shutdownTimeout`
   * for the node to shutdown itself properly. If that doesn't work as expected the
   * node is killed.
   *
   * @returns {Promise<void>} resolves if the node could be stopped, rejects with error otherwise.
   */
  stop(): Promise<void> {
    const { _node, _log, _config, tlsConfig, _storePreviousPID, _storePreviousPort } = this;
    if (!_node || !this._canBeStopped()) return Promise.resolve();
    return new Promise(async (resolve, reject) => {
      _log.info('CardanoNode: disconnecting from cardano-node process.');
      try {
        _node.disconnect();
        this._changeToState(CardanoNodeStates.STOPPING);
        await promisedCondition(
          () => this._state === CardanoNodeStates.STOPPED,
          _config.shutdownTimeout
        );
        // store _node's pid and port for reference in next session
        await _storePreviousPID(_node.pid);
        await _storePreviousPort(tlsConfig.port);

        this._reset();
        resolve();
      } catch (e) {
        _log.info('CardanoNode: cardano-node did not shut itself down correctly.');
        try {
          await this.kill();
        } catch (killError) {
          reject(killError);
        }
      }
    });
  }

  /**
   * Kills cardano-node and waitsup to `killTimeout` for the node to
   * report the exit message.
   *
   * @returns {Promise<void>} resolves if the node could be killed, rejects with error otherwise.
   */
  kill(): Promise<void> {
    const { _node, _log, _config, tlsConfig, _storePreviousPID, _storePreviousPort } = this;
    if (!_node || !this._canBeStopped()) return Promise.reject('Node not active.');
    return new Promise(async (resolve, reject) => {
      try {
        _log.info('CardanoNode: killing cardano-node process.');
        _node.kill();
        await promisedCondition(
          () => this._state === CardanoNodeStates.STOPPED,
          _config.killTimeout
        );
        // store _node's pid and port for reference in next session
        await _storePreviousPID(_node.pid);
        await _storePreviousPort(tlsConfig.port);

        this._reset();
        resolve();
      } catch (_) {
        _log.info('CardanoNode: could not kill cardano-node.');
        // store _node's pid and port for reference in next session
        await _storePreviousPID(_node.pid);
        await _storePreviousPort(tlsConfig.port);

        this._reset();
        reject('Could not kill cardano-node.');
      }
    });
  }

  async restart(): Promise<void> {
    const { _log } = this;
    try {
      if (this._canBeStopped()) {
        await this.stop();
      }
      await this.start(this._config);
    } catch (error) {
      _log.info(`CardanoNode: Could not restart cardano-node "${error}"`);
      return Promise.reject(error);
    }
  }

  /**
   * Uses the configured action to send the tls config to
   * outside consumers, when something changed internally
   * or when this method is called from outside.
   */
  broadcastTlsConfig() {
    if (this._tlsConfig) {
      this._actions.broadcastTlsConfig(this._tlsConfig);
    } else {
      this._log.error('CardanoNode: Cannot broadcast tls config before it was set.');
    }
  }

  /**
   * Changes the internal state to UPDATING.
   * Waits up to the configured `updateTimeout` for the UPDATED state.
   * Kills cardano-node if it didn't properly update.
   *
   * @returns {Promise<void>} resolves if the node updated, rejects with error otherwise.
   */
  expectNodeUpdate(): Promise<void> {
    const { _log, _config } = this;
    this._changeToState(CardanoNodeStates.UPDATING);
    return new Promise(async (resolve) => {
      try {
        _log.info('CardanoNode: waiting for node to apply update.');
        await promisedCondition(
          () => this._state === CardanoNodeStates.UPDATED,
          _config.updateTimeout
        );
        resolve();
      } catch (stopError) {
        _log.info('CardanoNode: did not apply update correctly. Killing it.');
        return await this.kill();
      }
    });
  }

  // ================================= PRIVATE ===================================

  /**
   * Spawns cardano-node as child_process in ipc mode writing to given log file
   * @param nodePath {string}
   * @param args {NodeArgs}
   * @param logFile {WriteStream}
   * @returns {ChildProcess}
   * @private
   */
  _spawnNode(nodePath: string, args: NodeArgs, logFile: WriteStream) {
    return this._actions.spawn(
      nodePath, args, { stdio: ['inherit', logFile, logFile, 'ipc'] }
    );
  }

  /**
   * Handles node ipc messages sent by the cardano-node process.
   * Updates the tls config where possible and broadcasts it to
   * the outside if it is complete. Transitions into RUNNING state
   * after it broadcasted the tls config (that's the difference between
   * STARTING and RUNNING).
   *
   * @param msg
   * @private
   */
  _handleCardanoNodeMessage = (msg: CardanoNodeIpcMessage) => {
    const { _log, _actions } = this;
    const { tlsPath } = this._config;
    _log.info(`CardanoNode: received message: ${JSON.stringify(msg)}`);
    if (msg != null && msg.ReplyPort != null) {
      const port: number = msg.ReplyPort;
      this._tlsConfig = {
        ca: _actions.readFileSync(tlsPath + '/client/ca.crt'),
        key: _actions.readFileSync(tlsPath + '/client/client.key'),
        cert: _actions.readFileSync(tlsPath + '/client/client.pem'),
        port,
      };
      if (this._state === CardanoNodeStates.STARTING) {
        this._changeToState(CardanoNodeStates.RUNNING);
        this.broadcastTlsConfig();
        // Reset the startup tries when we managed to get the node running
        this._startupTries = 0;
      }
    }
  };

  _handleCardanoNodeError = async (error: Error) => {
    const { _log } = this;
    _log.info(`CardanoNode: error: ${error.toString()}`);
    this._changeToState(CardanoNodeStates.ERRORED);
    this._transitionListeners.onError(error);
    await this.restart();
  };

  _handleCardanoNodeExit = (code: number, signal: string) => {
    // console.log(`ON EXIT: ${JSON.stringify(this._tlsConfig.ca)}`);
    const { _log } = this;
    _log.info(`CardanoNode: cardano-node exited with: ${code}, ${signal}`);
    if (this._state === CardanoNodeStates.STOPPING) {
      this._changeToState(CardanoNodeStates.STOPPED);
    } else if (this._state === CardanoNodeStates.UPDATING) {
      this._changeToState(CardanoNodeStates.UPDATED);
    } else if (this._state !== CardanoNodeStates.UPDATED) {
      this._changeToState(CardanoNodeStates.CRASHED, code, signal);
    }
    this._reset();
  };

  _resetTlsConfig = () => this._tlsConfig = null;

  _reset = () => {
    if (this._cardanoLogFile) this._cardanoLogFile.end();
    if (this._node) {
      this._node.removeAllListeners();
      this._node = null;
    }
    this._resetTlsConfig();
  };

  _changeToState(state: CardanoNodeState, ...args: Array<any>) {
    const { _log, _transitionListeners } = this;
    _log.info(`CardanoNode: transitions to <${state}>`);
    this._state = state;
    this._actions.broadcastStateChange(state);
    switch (state) {
      case CardanoNodeStates.STARTING: return _transitionListeners.onStarting();
      case CardanoNodeStates.RUNNING: return _transitionListeners.onRunning();
      case CardanoNodeStates.STOPPING: return _transitionListeners.onStopping();
      case CardanoNodeStates.STOPPED: return _transitionListeners.onStopped();
      case CardanoNodeStates.UPDATING: return _transitionListeners.onUpdating();
      case CardanoNodeStates.UPDATED: return _transitionListeners.onUpdated();
      case CardanoNodeStates.CRASHED: return _transitionListeners.onCrashed(...args);
      default:
    }
  }

  /**
   * Checks if cardano-node child_process has been created, and is connected, and is stateful
   * @returns {boolean}
   */
  _isAwake = (): boolean => (
    this._node != null && this._node.connected && (
      this._state === CardanoNodeStates.STARTING ||
      this._state === CardanoNodeStates.RUNNING ||
      this._state === CardanoNodeStates.STOPPING ||
      this._state === CardanoNodeStates.UPDATING
    )
  );

  /**
   * Checks if current cardano-node child_process is "awake" (created, connected, stateful)
   * If node is already awake, returns false.
   * Kills process with PID that matches PID of the previously running
   * cardano-node child_process that didn't shut down properly
   * @returns {boolean}
   * @private
   */
  _canBeStarted = async (tlsPath: string): Promise<boolean> => {
    if (this._isAwake()) { return false; }
    await this._ensurePreviousCardanoNodeIsNotRunning(tlsPath);
    return true;
  };

  _canBeStopped = () => this._isAwake();

  _ensurePreviousCardanoNodeIsNotRunning = async (tlsPath: string): Promise<void> => {
    this._log.info('CardanoNode: checking previous port and pid for an instance of cardano-node');
    const previousPort: ?number = await this._getPreviousPort();
    const previousPID: ?number = await this._getPreviousPID();

    if (previousPort == null || previousPID == null) return;

    const previousPortTaken = previousPort ? await portIsTaken(previousPort) : false;
    this._log.info(`previous port was taken: ${previousPortTaken.toString()}`);

    const portIsCardanoNode = (
      previousPortTaken ? await this._portIsCardanoNode(tlsPath, previousPort) : false
    );
    const previousProcessIsRunning = previousPID ? await processIsRunning(previousPID) : false;
    this._log.info(`previousProcessIsRunning result: ${previousProcessIsRunning.toString()}`);

    if (portIsCardanoNode && previousProcessIsRunning) {
      this._log.info('CardanoNode: attempting to kill running process of previous cardano-node');
      // kill previous process
      await this._killPreviousProcess(previousPID);
    }
    this._log.info('Previous instance of cardano-node does not exist');
  };

  _portIsCardanoNode = async (tlsPath: string, previousPort: number): Promise<boolean> => {
    // make req to identify as cardano-node
    const { ca, cert, key } = Object.assign({}, {
      ca: this._actions.readFileSync(tlsPath + '/client/ca.crt'),
      key: this._actions.readFileSync(tlsPath + '/client/client.key'),
      cert: this._actions.readFileSync(tlsPath + '/client/client.pem'),
    });

    try {
      this._log.info(`CardanoNode: sending node-info req to previous port: ${previousPort}`);
      const nodeInfo = await request({
        hostname: 'localhost',
        method: 'GET',
        path: '/api/v1/node-info',
        ca,
        cert,
        key,
        port: previousPort
      }, {});
      this._log.info(`CardanoNode: node-info req success. Response: ${JSON.stringify(nodeInfo)}`);

      // previous cardano-node successfuly identified
      return (nodeInfo && nodeInfo.status === 'success');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        this._log.info(`
          CardanoNode: node-info req failed. Error Code: ${JSON.stringify(error.code)}
          Previous port is not occupied by an instance of cardano-node.
        `);
        return false;
      }
      this._log.info(`CardanoNode: node-info req failed. Error: ${JSON.stringify(error)}`);
      return false;
    }
  };

  // kills the previous process on which the cardano-node child_process was running.
  _killPreviousProcess = (pid: number): Promise<void> => new Promise((resolve, reject) => {
    try {
      setTimeout(() => process.kill(pid), 1000);
      this._log.info(`CardanoNode: cardano-node child process with pid ${pid} was killed.`);
      resolve();
    } catch (error) {
      this._log.info(`
        CardanoNode: _killPreviousProcess returned an error after an attempting
        to kill a process with pid ${pid}. Error received: ${JSON.stringify(error)}
      `);
      reject(error);
    }
  });

  // persists the current port on which the cardano-node child_process is running.
  _storePreviousPort = (port: number): Promise<void> => new Promise((resolve, reject) => {
    try {
      // saves current port in file system
      store.set(PREVIOUS_PORT, port);
      this._log.info('CardanoNode: previous port stored successfuly');
      resolve();
    } catch (error) {
      this._log.info(`CardanoNode: failed to store previous port. Error: ${JSON.stringify(error)}`);
      reject(error);
    }
  });

  // retrieves the last known port on which the cardano-node child_process was running.
  _getPreviousPort = (): Promise<?number> => new Promise((resolve, reject) => {
    try {
      // retrieves previous port from file system
      const port: ?number = store.get(PREVIOUS_PORT);

      if (!port) {
        this._log.info('CardanoNode: get previous port returned null');
        resolve(null);
      }

      this._log.info(`CardanoNode: get previous port success. Port: ${JSON.stringify(port)}`);
      resolve(port);
    } catch (error) {
      this._log.info(`CardanoNode: get previous port failed. Error: ${JSON.stringify(error)}`);
      reject(error);
    }
  });

  // persists the current PID on which the cardano-node child_process is running.
  _storePreviousPID = (pid: number): Promise<void> => new Promise((resolve, reject) => {
    try {
      // saves current PID in file system
      store.set(PREVIOUS_PID, pid);
      this._log.info('CardanoNode: previous PID stored successfuly');
      resolve();
    } catch (error) {
      this._log.info(`CardanoNode: failed to store previous PID. Error: ${JSON.stringify(error)}`);
      reject(error);
    }
  });

  // retrieves the last known PID on which the cardano-node child_process was running.
  _getPreviousPID = (): Promise<?number> => new Promise((resolve, reject) => {
    try {
      // retrieves previous PID from file system
      const pid: ?number = store.get(PREVIOUS_PID);

      if (!pid) {
        this._log.info('CardanoNode: get previous PID returned null');
        resolve(null);
      }

      this._log.info(`CardanoNode: get previous PID success. PID: ${JSON.stringify(pid)}`);
      resolve(pid);
    } catch (error) {
      this._log.info(`CardanoNode: get previous PID failed. Error: ${JSON.stringify(error)}`);
      reject(error);
    }
  });

}

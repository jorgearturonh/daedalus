// @flow
import log from 'electron-log';

const isRenderer = () => {
  // running in a web browser
  if (typeof process === 'undefined') return true;
  // node-integration is disabled
  if (!process) return true;
  // We're in node.js somehow
  if (!process.type) return false;
  return process.type === 'renderer';
};

const prefixProcessType = (str: string) => (isRenderer() ? '[renderer] ' : '[main] ') + str;

const logToLevel = (level) => (message: string) => log[level](prefixProcessType(message));

export const Logger = {
  debug: logToLevel('debug'),
  info: logToLevel('info'),
  error: logToLevel('error'),
  warn: logToLevel('warn'),
};

// ========== STRINGIFY =========

export const stringifyData = (data: any) => JSON.stringify(data, null, 2);

export const stringifyError = (error: any) => (
  JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
);


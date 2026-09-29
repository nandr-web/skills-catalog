// The stand-in's server (moto on werkzeug) answers every request with `Connection: close`, so no connection is reused
// and each request leaves its socket waiting to close (TIME_WAIT) on this machine for 30 s: a hosted run makes about
// 12,000 requests, most of the ports the machine shares. These tests' clients end each connection with a reset instead,
// once its answer is read, and a reset leaves nothing waiting. Tests only: S3 and DynamoDB keep connections alive.

import { Agent } from 'node:http';
import type { Socket } from 'node:net';

export function noWaitAgent(): Agent {
  const agent = new Agent({ keepAlive: false });
  const connect = agent.createConnection.bind(agent);
  agent.createConnection = ((...args: Parameters<Agent['createConnection']>) => {
    const socket = connect(...args) as Socket;
    // Node's client ends a connection its server said to close with destroySoon: a FIN, then TIME_WAIT on this side.
    socket.destroySoon = () => void socket.resetAndDestroy();
    return socket;
  }) as Agent['createConnection'];
  return agent;
}

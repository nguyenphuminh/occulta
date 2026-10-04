import type { Request, Response } from 'express';
import { runCommand } from './node.commands.ts';
import type { NodeService } from './node.service.ts';

/** RPC: `POST /rpc/<command>` with the command's input as a JSON object. */
export class NodeController {
  private readonly node: NodeService;

  constructor(node: NodeService) {
    this.node = node;
  }

  run = async (req: Request<{ command: string }>, res: Response): Promise<void> => {
    res.json(await runCommand(this.node, req.params.command, req.body ?? {}));
  };
}

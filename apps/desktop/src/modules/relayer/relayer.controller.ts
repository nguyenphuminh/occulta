import type { Request, Response } from 'express';
import type { RelayerService } from '@occulta/framework';

/** The public relayer API the framework's HttpRelayer calls (BRD 2.2.11). */
export class RelayerController {
  private readonly relayer: RelayerService;

  constructor(relayer: RelayerService) {
    this.relayer = relayer;
  }

  info = (_req: Request, res: Response): void => {
    res.json(this.relayer.info());
  };

  /** The request is validated by the relayer service itself, which also checks the fee note. */
  submit = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.relayer.relay(req.body));
  };
}

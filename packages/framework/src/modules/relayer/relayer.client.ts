import { AppError } from '../../shared/errors/AppError.ts';
import { tokenAddress } from '../chain/index.ts';
import { RelayResultSchema, RelayerInfoSchema, type RelayRequest, type RelayResult, type RelayerInfo, type RelayerPort } from './relayer.schema.ts';
import type { RelayerService } from './relayer.service.ts';

/** The relayer's quoted fee for a token (0 = ETH), or an error if it does not accept that token. */
export function quotedFee(info: RelayerInfo, token: bigint): bigint {
  const fee = info.fees[tokenAddress(token).toLowerCase()];
  if (fee === undefined) throw new AppError(409, 'TOKEN_NOT_ACCEPTED', 'This relayer does not accept fees in that token');
  return BigInt(fee);
}

/** A relayer reached over HTTP (the desktop client's relayer mode serves this API). */
export class HttpRelayer implements RelayerPort {
  readonly url: string;

  constructor(url: string) {
    this.url = url.replace(/\/+$/, '');
  }

  async info(): Promise<RelayerInfo> {
    return RelayerInfoSchema.parse(await this.request('GET', '/relayer/info'));
  }

  async submit(request: RelayRequest): Promise<RelayResult> {
    return RelayResultSchema.parse(await this.request('POST', '/relayer/submit', request));
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new AppError(503, 'RELAYER_UNREACHABLE', `Relayer ${this.url} is unreachable`);
    }
    const payload = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
    if (!response.ok) throw new AppError(response.status, payload.code ?? 'RELAYER_ERROR', payload.message ?? 'The relayer refused the transaction');
    return payload;
  }
}

/** A relayer running in the same process. */
export class DirectRelayer implements RelayerPort {
  private readonly service: RelayerService;

  constructor(service: RelayerService) {
    this.service = service;
  }

  async info(): Promise<RelayerInfo> {
    return this.service.info();
  }

  submit(request: RelayRequest): Promise<RelayResult> {
    return this.service.relay(request);
  }
}

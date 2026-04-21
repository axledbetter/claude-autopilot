import type { AdapterBase } from '../base.ts';
import type { Finding } from '../../core/findings/types.ts';
import type { GenericComment, VcsHost } from '../vcs-host/types.ts';

export interface ReviewBotParser extends AdapterBase {
  detect(comment: GenericComment): boolean;
  fetchFindings(vcs: VcsHost, pr: number | string): Promise<Finding[]>;
  detectDismissal(reply: string): boolean;
}

export interface CouncilAdapter {
  readonly label: string;
  consult(prompt: string, context: string): Promise<string>;
}

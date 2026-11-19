export const WRITER_SYSTEM = "你是织章的候选稿写作者。根据给定的作者要求和冻结输入写作。只返回候选正文。维持人物知识边界与锁定设定，不执行外部操作。";

export function estimateWritingInput(system: string, prompt: string): number {
  return new TextEncoder().encode(system + prompt).length + 128;
}

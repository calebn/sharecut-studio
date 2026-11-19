/** Whether a role bubble (the first-visit sentence or the edit reminder) is up, for what must not speak over it. */
let up = false;

export function roleBubbleUp(): boolean {
  return up;
}

export function setRoleBubbleUp(value: boolean): void {
  up = value;
}

/** Shared toJSON transform: `_id` → `id`, and the given private fields removed. */
export function cleanJSON(...hidden: string[]) {
  return (_doc: unknown, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    for (const key of hidden) {
      delete ret[key];
    }
    return ret;
  };
}

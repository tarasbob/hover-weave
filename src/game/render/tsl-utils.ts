/**
 * @types/three models every TSL function with strict per-arity overloads,
 * which collapse when composing node graphs through plain TS helpers.
 * This loose handle is the community-standard escape hatch: runtime nodes are
 * duck-typed anyway, and material/node assignment stays fully checked.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NodeAny = any;

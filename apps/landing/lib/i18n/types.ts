import type en from "./messages/en";

/**
 * The catalogue shape, derived from the English one rather than declared twice.
 *
 * Deriving it means English is the only place a key is authored: add one there
 * and the five translations stop compiling until they have it too. Declaring the
 * interface by hand would let a key exist in the type and in no catalogue, which
 * is the same missing string with more steps.
 *
 * Widen is what makes the derivation usable. `typeof en` gives literal types, so
 * a translated string would not satisfy the English literal it replaces. This
 * maps every leaf back to `string` while keeping the object shape exact.
 */
type Widen<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Widen<U>[]
    : { [K in keyof T]: Widen<T[K]> };

export type Messages = Widen<typeof en>;

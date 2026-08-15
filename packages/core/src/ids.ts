import { nanoid } from 'nanoid';

/** ID estable de entidad (12 chars es de sobra para un proyecto). */
export function newId(): string {
  return nanoid(12);
}

import path from 'node:path';
import { env } from '../../config/env';

export const fotosDir = (): string => path.resolve(env.RH_STORAGE_DIR, 'fotos');
export const documentosDir = (): string => path.resolve(env.RH_STORAGE_DIR, 'documentos');

import { createContext, useContext } from 'react';

export interface SuperuserCtx {
  active: boolean;
  password: string;
}

export const SuperuserContext = createContext<SuperuserCtx>({ active: false, password: '' });

export function useSuperuser() { return useContext(SuperuserContext); }

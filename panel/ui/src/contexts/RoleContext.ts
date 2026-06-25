import { createContext, useContext } from 'react';
import { UserRole } from '../api/auth.ts';

export const RoleContext = createContext<UserRole>('readonly');

export function useRole(): UserRole {
  return useContext(RoleContext);
}

export function useIsAdmin(): boolean {
  return useContext(RoleContext) === 'admin';
}

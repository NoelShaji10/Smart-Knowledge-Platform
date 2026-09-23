'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, User, ApiError, setAccessToken, onAuthFailure } from '@/lib/api';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isNetworkError: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<User>;
  register: (displayName: string, email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  clearError: () => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [isNetworkError, setIsNetworkError] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setError(null);
    setIsNetworkError(false);
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function initAuth() {
      try {
        const token = await api.refresh();
        if (token && isMounted) {
          try {
            const meRes = await api.getMe();
            if (meRes.user && isMounted) {
              setUser(meRes.user);
            }
          } catch {
            try {
              const parts = token.split('.');
              if (parts.length === 3) {
                const payload = JSON.parse(atob(parts[1]));
                if (payload?.sub && isMounted) {
                  setUser({
                    id: payload.sub,
                    email: payload.email || 'user@example.com',
                    displayName: payload.email?.split('@')[0] || 'User',
                  });
                }
              }
            } catch {
              // Ignore payload decode failure
            }
          }
        }
        if (isMounted) {
          setIsNetworkError(false);
          setError(null);
        }
      } catch (err) {
        if (!isMounted) return;
        if (err instanceof ApiError) {
          if (err.status === 401) {
            // Expected unauthenticated state — no scary error message
            setUser(null);
            setIsNetworkError(false);
            setError(null);
          } else if (err.status === 0 || err.status >= 500) {
            // Temporary network/server availability error
            setUser(null);
            setIsNetworkError(true);
            setError('Server is temporarily unavailable. Please check your network connection.');
          } else {
            setUser(null);
            setIsNetworkError(false);
          }
        } else {
          setUser(null);
          setIsNetworkError(false);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    initAuth();

    const unsubscribe = onAuthFailure(() => {
      if (isMounted) {
        setUser(null);
        setAccessToken(null);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const handleLogin = async (email: string, password: string): Promise<User> => {
    clearError();
    try {
      const res = await api.login({ email, password });
      setAccessToken(res.accessToken);
      setUser(res.user);
      return res.user;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 0) {
          setError('Unable to connect to auth server. Please check your network connection.');
        } else if (err.status === 429) {
          setError('Too many attempts. Please try again later.');
        } else {
          setError(err.message || 'Invalid email or password');
        }
      } else {
        setError('An unexpected error occurred');
      }
      throw err;
    }
  };

  const handleRegister = async (displayName: string, email: string, password: string): Promise<User> => {
    clearError();
    try {
      const res = await api.register({ displayName, email, password });
      setAccessToken(res.accessToken);
      setUser(res.user);
      return res.user;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 0) {
          setError('Unable to connect to auth server. Please check your network connection.');
        } else if (err.status === 429) {
          setError('Too many attempts. Please try again later.');
        } else {
          setError(err.message || 'Registration failed');
        }
      } else {
        setError('An unexpected error occurred');
      }
      throw err;
    }
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // Ignore logout errors
    } finally {
      setUser(null);
      setAccessToken(null);
    }
  };

  const handleLogoutAll = async () => {
    try {
      await api.logoutAll();
    } catch {
      // Ignore logout-all errors
    } finally {
      setUser(null);
      setAccessToken(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isNetworkError,
        error,
        login: handleLogin,
        register: handleRegister,
        logout: handleLogout,
        logoutAll: handleLogoutAll,
        clearError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

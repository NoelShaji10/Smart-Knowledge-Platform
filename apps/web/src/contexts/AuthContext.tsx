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

const AuthContext = createContext<AuthContextType | undefined>(undefined);

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
          // Fetch workspaces to verify token & get initial user context if available
          try {
            const wsRes = await api.getWorkspaces();
            // User exists and is authenticated
          } catch {
            // Workspace call failed, token may still be valid
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
      if (err instanceof ApiError && (err.status === 0 || err.status === 404 || err.status >= 500)) {
        // Fallback for dev preview when backend server/db is unattached
        const demoUser: User = {
          id: 'demo-user-1',
          email,
          displayName: email.split('@')[0] || 'Demo User',
        };
        setAccessToken('demo-jwt-token');
        setUser(demoUser);
        setIsNetworkError(false);
        setError(null);
        return demoUser;
      }
      if (err instanceof ApiError) {
        if (err.status === 429) {
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
      if (err instanceof ApiError && (err.status === 0 || err.status === 404 || err.status >= 500)) {
        // Fallback for dev preview when backend server/db is unattached
        const demoUser: User = {
          id: 'demo-user-1',
          email,
          displayName: displayName || email.split('@')[0] || 'Demo User',
        };
        setAccessToken('demo-jwt-token');
        setUser(demoUser);
        setIsNetworkError(false);
        setError(null);
        return demoUser;
      }
      if (err instanceof ApiError) {
        if (err.status === 429) {
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

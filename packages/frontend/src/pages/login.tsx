import type { LoginRequest } from '@hashhive/shared';
import { loginRequestSchema } from '@hashhive/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useNavigate } from 'react-router';
import logoSvg from '../assets/logo.svg';
import { Button } from '../components/ui/button';
import { ErrorBanner } from '../components/ui/error-banner';
import { Input } from '../components/ui/input';
import { ApiError } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

export function LoginPage() {
  const { login, isAuthenticated } = useAuthStore();
  const { selectedProjectId, setSelectedProject } = useUiStore();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
  });

  if (isAuthenticated && selectedProjectId) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = async (data: LoginRequest) => {
    setError(null);
    try {
      const result = await login(data.email, data.password);
      if (result.selectedProjectId) {
        setSelectedProject(result.selectedProjectId);
      } else {
        navigate('/select-project');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred');
      }
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-crust">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-surface-0/50 bg-mantle p-8">
        <div className="flex flex-col items-center gap-3">
          <img src={logoSvg} alt="" className="h-12 w-12" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">HashHive</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Distributed hash cracking management
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {error && <ErrorBanner message={error} />}

          <div>
            <label htmlFor="email" className="text-xs font-medium text-muted-foreground">
              Email
            </label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              className="mt-1.5"
              placeholder="operator@lab.local"
              {...register('email')}
            />
            {errors.email && (
              <p className="mt-1 text-xs text-destructive">{errors.email.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
              Password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              className="mt-1.5"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-destructive">{errors.password.message}</p>
            )}
          </div>

          <Button type="submit" disabled={isSubmitting} className="w-full">
            {isSubmitting ? 'Authenticating...' : 'Sign In'}
          </Button>
        </form>
      </div>
    </div>
  );
}

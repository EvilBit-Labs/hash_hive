import { useState } from 'react';
import { Navigate } from 'react-router';
import logoSvg from '../assets/logo.svg';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

export function SelectProjectPage() {
  const { user, isAuthenticated, isLoading, selectProject } = useAuthStore();
  const { selectedProjectId, setSelectedProject } = useUiStore();
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-crust">
        <p className="text-sm text-muted-foreground">Loading\u2026</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (selectedProjectId) {
    return <Navigate to="/" replace />;
  }

  const projects = user?.projects ?? [];

  const handleSelect = async (projectId: number) => {
    setSelecting(true);
    setError(null);
    try {
      await selectProject(projectId);
      setSelectedProject(projectId);
    } catch {
      setError('Failed to select project. Please try again.');
    } finally {
      setSelecting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-crust">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-surface-0/50 bg-mantle p-8">
        <div className="flex flex-col items-center gap-3">
          <img src={logoSvg} alt="" className="h-10 w-10" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">Select Project</h1>
            <p className="mt-1 text-xs text-muted-foreground">Choose a project to continue</p>
          </div>
        </div>

        {error && (
          <div className="rounded border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {projects.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            No projects available. Contact an administrator.
          </p>
        ) : (
          <div className="space-y-2">
            {projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                disabled={selecting}
                onClick={() => handleSelect(project.projectId)}
                className="w-full rounded-md border border-surface-0 bg-background px-4 py-3 text-left transition-all hover:border-primary/30 hover:bg-surface-0/40 disabled:opacity-50"
              >
                <div className="text-sm font-medium text-foreground">{project.projectName}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {project.roles.join(', ')}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { Navigate } from 'react-router';
import logoSvg from '../assets/logo.svg';
import { EmptyState } from '../components/ui/empty-state';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

export function SelectProjectPage() {
  const { user, isAuthenticated, isLoading } = useAuthStore();
  const { selectedProjectId, setSelectedProject } = useUiStore();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-crust">
        <EmptyState message="Loading..." />
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

  const handleSelect = (projectId: number) => {
    setSelectedProject(projectId);
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

        {projects.length === 0 ? (
          <EmptyState
            message="No projects available. Contact an administrator."
            className="text-center"
          />
        ) : (
          <div className="space-y-2">
            {projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                onClick={() => handleSelect(project.projectId)}
                className="w-full rounded-md border border-surface-0 bg-background px-4 py-3 text-left transition-all hover:border-primary/30 hover:bg-surface-0/40 disabled:opacity-50"
              >
                <div className="text-sm font-medium text-foreground">{project.projectName}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
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

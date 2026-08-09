import { Suspense } from "react";
import ConnectTwitterPage from "@/screens/connect-twitter";

function LoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      <div className="text-center">
        <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-purple-500 border-t-transparent mx-auto"></div>
        <p className="text-purple-200">Loading...</p>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ConnectTwitterPage />
    </Suspense>
  );
}

import { lazy } from "react";
import { Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { CartProvider } from "./providers/CartProvider";
import { OnboardingProvider } from "./providers/OnboardingProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RouteBoundary, SuspenseRoute } from "./components/RouteBoundary";
import { useReducedMotion } from "./components/ReducedMotionProvider";
import Home from "./pages/Home";

const BrowsePage = lazy(() => import("./pages/browse/page.jsx"));
const SellPage = lazy(() => import("./pages/sell/page.tsx"));
const ChatHome = lazy(() => import("./pages/chat/page.tsx"));
const ProfilePage = lazy(() => import("./pages/profile/page.tsx"));
const PromptDetailPage = lazy(() => import("./pages/prompt/page.tsx"));
const CreatorSharePage = lazy(() => import("./pages/creator/page.tsx"));
const ComparePage = lazy(() => import("./pages/compare/page.tsx"));
const StatusPage = lazy(() => import("./pages/status/page.tsx"));
const ModerationPage = lazy(() => import("./pages/Moderation.tsx"));
const ApiKeysPage = lazy(() => import("./pages/settings/ApiKeys.tsx"));
const WebhookReplayConsolePage = lazy(() => import("./pages/settings/WebhookReplayConsole.tsx"));
const TransactionHistoryPage = lazy(() => import("./pages/history/page.tsx"));
const FavoritesPage = lazy(() => import("./pages/favorites/page.tsx"));
const CollectionDetailPage = lazy(() => import("./pages/collections/page.tsx"));
const CreatorAnalyticsPage = lazy(() => import("./pages/analytics/page.tsx"));
const SandboxPage = lazy(() => import("./pages/sandbox/page.tsx"));

/** Fade + slide transition applied to the active route on navigation. */
const PageTransition = () => {
  const location = useLocation();
  const { prefersReducedMotion } = useReducedMotion();

  if (prefersReducedMotion) {
    return <Outlet />;
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <Outlet />
      </motion.div>
    </AnimatePresence>
  );
};

const AppLayout = () => (
  <main className="min-h-screen bg-slate-950 text-white pb-16 sm:pb-0">
    <PageTransition />
  </main>
);

function ApplicationShell() {
  const { pathname } = useLocation();

  return (
    <ErrorBoundary routeName="Application" reportPath={pathname}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route
            path="/"
            element={
              <RouteBoundary routeName="Home">
                <Home />
              </RouteBoundary>
            }
          />
          <Route
            path="/browse"
            element={
              <SuspenseRoute routeName="Browse">
                <BrowsePage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/prompt/:id"
            element={
              <SuspenseRoute routeName="Prompt Detail">
                <PromptDetailPage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/creator/:address"
            element={
              <SuspenseRoute routeName="Creator">
                <CreatorSharePage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/compare"
            element={
              <SuspenseRoute routeName="Compare">
                <ComparePage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/sell"
            element={
              <SuspenseRoute routeName="Sell">
                <SellPage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/chat"
            element={
              <SuspenseRoute routeName="Chat">
                <ChatHome />
              </SuspenseRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <SuspenseRoute routeName="Profile">
                <ProfilePage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/status"
            element={
              <SuspenseRoute routeName="Status">
                <StatusPage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/sandbox"
            element={
              <SuspenseRoute routeName="Developer Sandbox">
                <SandboxPage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/settings/api-keys"
            element={
              <SuspenseRoute routeName="API Keys">
                <ApiKeysPage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/settings/webhooks/replay"
            element={
              <SuspenseRoute routeName="Webhook Replay Console">
                <WebhookReplayConsolePage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/moderation"
            element={
              <SuspenseRoute routeName="Moderation">
                <ModerationPage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/history"
            element={
              <SuspenseRoute routeName="Transaction History">
                <TransactionHistoryPage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/favorites"
            element={
              <SuspenseRoute routeName="Favorites">
                <FavoritesPage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/collections/:id"
            element={
              <SuspenseRoute routeName="Collection Detail">
                <CollectionDetailPage />
              </SuspenseRoute>
            }
          />
          <Route
            path="/analytics"
            element={
              <SuspenseRoute routeName="Creator Analytics">
                <CreatorAnalyticsPage />
              </SuspenseRoute>
            }
          />
          <Route
            path="*"
            element={
              <RouteBoundary routeName="Not Found">
                <Home />
              </RouteBoundary>
            }
          />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <CartProvider>
      <OnboardingProvider>
        <ApplicationShell />
      </OnboardingProvider>
    </CartProvider>
  );
}

export default App;

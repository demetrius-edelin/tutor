import { Layout, Notice } from "./components/Layout";
import { href, useRoute } from "./router";
import { ConceptMap } from "./screens/ConceptMap";
import { Home } from "./screens/Home";
import { Select } from "./screens/Select";
import { Session } from "./screens/Session";
import { Theme } from "./screens/Theme";

export function App() {
  const route = useRoute();
  switch (route.name) {
    case "home":
      return <Home />;
    case "theme":
      return <Theme slug={route.slug} />;
    case "map":
      return <ConceptMap key={route.slug} slug={route.slug} focus={route.concept} />;
    case "select":
      return <Select key={`${route.slug}-${route.moduleId}`} slug={route.slug} moduleId={route.moduleId} />;
    case "session":
      return <Session key={route.id} id={route.id} />;
    default:
      return (
        <Layout crumbs={[]}>
          <Notice title="This page does not exist">
            <p>
              <a href={href.home()}>Go to the themes</a>
            </p>
          </Notice>
        </Layout>
      );
  }
}

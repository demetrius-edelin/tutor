import { Layout, Notice } from "./components/Layout";
import { href, useRoute } from "./router";
import { ConceptMap } from "./screens/ConceptMap";
import { Home } from "./screens/Home";
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

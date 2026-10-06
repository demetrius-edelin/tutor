import { Layout, Notice } from "./components/Layout";
import { href, useRoute } from "./router";
import { Board } from "./screens/Board";
import { ConceptMap } from "./screens/ConceptMap";
import { Home } from "./screens/Home";
import { Lesson } from "./screens/Lesson";
import { Queue } from "./screens/Queue";
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
      return <ConceptMap key={route.slug} slug={route.slug} focus={route.concept} focusModule={route.module} />;
    case "queue":
      return <Queue key={route.slug} slug={route.slug} />;
    case "board":
      return <Board key={route.slug} slug={route.slug} filters={{ show: route.show, starred: route.starred, find: route.find }} />;
    case "lesson":
      return <Lesson key={route.conceptId} conceptId={route.conceptId} />;
    case "session":
      return <Session key={route.id} id={route.id} />;
    default:
      return (
        <Layout>
          <Notice title="This page does not exist">
            <p>
              <a href={href.home()}>Go to the themes</a>
            </p>
          </Notice>
        </Layout>
      );
  }
}

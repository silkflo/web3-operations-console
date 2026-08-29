// pages/_app.js
//
// One global stylesheet for the whole app. Next.js only permits global CSS to
// be imported here, and this is the only global CSS the console has.

import "../styles/globals.css";

const App = ({ Component, pageProps }) => <Component {...pageProps} />;

export default App;

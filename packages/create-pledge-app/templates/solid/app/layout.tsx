import { type ParentComponent } from 'solid-js';

const Layout: ParentComponent = (props) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>PledgeStack Solid App</title>
      </head>
      <body>
        {props.children}
      </body>
    </html>
  );
};

export default Layout;

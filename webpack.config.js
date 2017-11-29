const fs = require('fs');
const path = require('path');
const webpack = require('webpack');

const nodeModules = fs
  .readdirSync('node_modules')
  .filter(x => ['.bin'].indexOf(x) === -1);

// const server = {
//   context: 
// }
const client = {
  context: path.join(__dirname, 'src'),
  entry: 'index.ts',
  output: {
    path: path.join(__dirname, 'dist', 'app'),
    filename: 'index.js',
    devtoolModuleFilenameTemplate: '[absolute-resource-path]'
  },
  devtool: 'source-map',
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    loaders: [
      {
        test: /\.ts$/,
        loader: 'awesome-typescript-loader',
        exclude: /node_modules/
      }
    ]
  }
}
